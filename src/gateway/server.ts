import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { OrderRefused, type OrderIntent } from '../broker/types';
import type { RiskGateway } from './risk';
import { accountReq, executionsReq, haltReq, noteReq, orderReq, placeReq, quoteReq, releaseReq } from './wire';

export interface GatewayServerOptions {
  gateway: RiskGateway;
  /** worker -> gateway */
  token: string;
  /** operator actions (reset breaker, release reservation); endpoints do not exist without it */
  adminToken?: string;
  host?: string; // default 127.0.0.1
  port?: number;
  /** run RiskGateway.evaluate() this often; 0 disables */
  evaluateEveryMs?: number;
  log?: (line: Record<string, unknown>) => void;
}

const MAX_BODY = 64 * 1024;

function same(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
function bearer(req: IncomingMessage): string {
  const h = req.headers.authorization ?? '';
  return h.startsWith('Bearer ') ? h.slice(7) : '';
}
function send(res: ServerResponse, status: number, body: unknown): void {
  const s = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(s), 'cache-control': 'no-store' });
  res.end(s);
}
async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of req) {
    n += (c as Buffer).length;
    if (n > MAX_BODY) throw Object.assign(new Error('body too large'), { http: 413 });
    chunks.push(c as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw Object.assign(new Error('invalid JSON'), { http: 400 });
  }
}

/** Separate process boundary: bind to loopback or a private interface only, never a public one. */
export function createGatewayServer(o: GatewayServerOptions): { server: Server; start(): Promise<number>; stop(): Promise<void> } {
  const log = o.log ?? (() => undefined);
  const g = o.gateway;

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://x');
      const path = url.pathname;
      const tok = bearer(req);
      const isAdmin = !!o.adminToken && same(tok, o.adminToken);
      const isWorker = same(tok, o.token) || isAdmin;
      if (path.startsWith('/admin/')) {
        if (!o.adminToken) return send(res, 404, { error: 'not found' });
        if (!isAdmin) return send(res, 401, { error: 'unauthorized' });
      } else if (!isWorker) {
        return send(res, 401, { error: 'unauthorized' });
      }

      if (req.method === 'GET' && path === '/capabilities') return send(res, 200, g.capabilities);
      if (req.method === 'GET' && path === '/capital') return send(res, 200, await g.capitalView());
      if (req.method === 'GET' && path === '/status') return send(res, 200, { state: g.status() });
      if (req.method !== 'POST') return send(res, 404, { error: 'not found' });

      const body = await readJson(req);
      switch (path) {
        case '/account': return send(res, 200, await g.account(accountReq.parse(body).accountId));
        case '/positions': return send(res, 200, await g.positions(accountReq.parse(body).accountId));
        case '/order': { const b = orderReq.parse(body); return send(res, 200, await g.getOrder(b.accountId, b.clientOrderId)); }
        case '/cancel': { const b = orderReq.parse(body); return send(res, 200, await g.cancel(b.accountId, b.clientOrderId)); }
        case '/executions': { const b = executionsReq.parse(body); return send(res, 200, await g.executions(b.accountId, b.sinceMs)); }
        case '/quote': return send(res, 200, await g.quoteFor(quoteReq.parse(body).instrumentId));
        case '/halt': await g.halt(haltReq.parse(body).reason); return send(res, 200, { ok: true });
        case '/place': return send(res, 200, await g.place(placeReq.parse(body).intent as OrderIntent));
        case '/admin/resume-reconciliation': await g.resumeAfterReconciliation(noteReq.parse(body).note); return send(res, 200, { ok: true });
        case '/admin/reset-drawdown': await g.resetDrawdown(noteReq.parse(body).note); return send(res, 200, { ok: true });
        case '/admin/release-reservation': { const b = releaseReq.parse(body); await g.releaseReservation(b.clientOrderId, b.note); return send(res, 200, { ok: true }); }
        default: return send(res, 404, { error: 'not found' });
      }
    } catch (e) {
      if (e instanceof OrderRefused) return send(res, 422, { refused: true, code: e.code, message: e.message });
      const http = (e as { http?: number }).http;
      if (http) return send(res, http, { error: (e as Error).message });
      if ((e as Error).name === 'ZodError') return send(res, 400, { error: 'invalid request' });
      log({ level: 'error', msg: 'gateway upstream error', error: (e as Error).message });
      // do not leak broker details to the caller
      return send(res, 502, { error: 'upstream failure' });
    }
  });
  server.requestTimeout = 15_000;

  let timer: NodeJS.Timeout | null = null;
  return {
    server,
    start: () =>
      new Promise<number>((resolve, reject) => {
        server.once('error', reject);
        server.listen(o.port ?? 0, o.host ?? '127.0.0.1', () => {
          const every = o.evaluateEveryMs ?? 5_000;
          if (every > 0) {
            timer = setInterval(() => {
              g.evaluate().catch((e) => log({ level: 'error', msg: 'evaluate failed', error: (e as Error).message }));
            }, every);
            timer.unref();
          }
          resolve((server.address() as { port: number }).port);
        });
      }),
    stop: () =>
      new Promise<void>((resolve) => {
        if (timer) clearInterval(timer);
        server.close(() => { g.close(); resolve(); });
      }),
  };
}
