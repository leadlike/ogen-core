import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { networkInterfaces } from 'node:os';
import { IbkrBroker } from '../broker/ibkr/broker';
import { StoqeyClient, type IbClient } from '../broker/ibkr/client';
import { IbkrQuotes } from '../broker/ibkr/quotes';
import { parseGatewayConfig, type GatewayLimits } from './config';
import { RiskGateway } from './risk';
import { createGatewayServer } from './server';
import { StateFile } from './state';

/** IB Gateway / TWS paper API ports. Live ports (4001, 4003, 7496) are refused: this build has no live mode. */
const PAPER_PORTS = new Set([4002, 4004, 7497]);

export interface DaemonSettings {
  limits: GatewayLimits;
  account: string;
  token: string;
  adminToken: string;
  stateFile: string;
  gatewayHost: string;
  gatewayPort: number;
  ibHost: string;
  ibPort: number;
  ibClientId: number;
  /** shared-volume deployments: take over a lock from another host whose heartbeat is older than this */
  lockStaleAfterMs?: number;
}

function privateHost(h: string): boolean {
  if (h === 'localhost') return true;
  if (isIP(h) === 6) return h === '::1';
  const p = h.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  return p[0] === 127 || p[0] === 10 || (p[0] === 172 && p[1]! >= 16 && p[1]! <= 31) || (p[0] === 192 && p[1] === 168);
}

type Ifaces = Record<string, Array<{ address: string; family: string | number; internal: boolean }> | undefined>;
/** The task's own private address (awsvpc gives each task one ENI), for GATEWAY_HOST=auto. Never 0.0.0.0, never a public address. */
export function privateAddress(ifaces: Ifaces = networkInterfaces() as unknown as Ifaces): string {
  const found: string[] = [];
  for (const list of Object.values(ifaces)) for (const a of list ?? []) {
    if ((a.family === 'IPv4' || a.family === 4) && !a.internal && privateHost(a.address) && !a.address.startsWith('127.')) found.push(a.address);
  }
  if (found.length !== 1) throw new Error(`ENV_HOST_AUTO: expected exactly one private address, found ${found.length ? found.join(', ') : 'none'}`);
  return found[0]!;
}

/** Reads and validates everything from the environment. Throws a message naming the first thing wrong; starts nothing. */
export function readSettings(env: NodeJS.ProcessEnv, readFile: (p: string) => string = (p) => readFileSync(p, 'utf8'), ifaces?: Ifaces): DaemonSettings {
  const need = (k: string): string => { const v = env[k]; if (!v) throw new Error(`ENV_MISSING: ${k}`); return v; };
  const token = need('GATEWAY_TOKEN'), adminToken = need('GATEWAY_ADMIN_TOKEN');
  if (token.length < 24 || adminToken.length < 24) throw new Error('ENV_WEAK_TOKEN: GATEWAY_TOKEN and GATEWAY_ADMIN_TOKEN need at least 24 characters');
  if (token === adminToken) throw new Error('ENV_SAME_TOKENS: the worker and admin tokens must differ');
  const account = need('IB_ACCOUNT');
  if (!/^DU\d+$/.test(account)) throw new Error('ENV_NOT_PAPER: IB_ACCOUNT must be a paper account (DU...)');
  const ibPort = Number(env.IB_PORT ?? 4004);
  if (!PAPER_PORTS.has(ibPort)) throw new Error(`ENV_NOT_PAPER_PORT: IB_PORT ${ibPort} is not a paper port (4002, 4004, 7497)`);
  const gatewayHost = env.GATEWAY_HOST === 'auto' ? privateAddress(ifaces) : (env.GATEWAY_HOST ?? '127.0.0.1');
  if (!privateHost(gatewayHost)) throw new Error(`ENV_PUBLIC_BIND: GATEWAY_HOST ${gatewayHost} is not loopback or a private address`);
  const gatewayPort = Number(env.GATEWAY_PORT ?? 8787);
  const ibClientId = Number(env.IB_CLIENT_ID ?? 17);
  if (env.GATEWAY_LOCK_STALE_MS && !(Number(env.GATEWAY_LOCK_STALE_MS) >= 15_000)) throw new Error('ENV_BAD_NUMBER: GATEWAY_LOCK_STALE_MS must be at least 15000');
  if (![gatewayPort, ibClientId].every((n) => Number.isInteger(n) && n >= 0 && n <= 65535)) throw new Error('ENV_BAD_NUMBER');
  // the risk limits come from a file, or inline (an ECS task injects them from a parameter, not a file)
  if (env.BROKER_RISK_CONFIG && env.BROKER_RISK_CONFIG_JSON) throw new Error('ENV_CONFLICT: set BROKER_RISK_CONFIG or BROKER_RISK_CONFIG_JSON, not both');
  const limits = parseGatewayConfig(JSON.parse(env.BROKER_RISK_CONFIG_JSON ?? readFile(need('BROKER_RISK_CONFIG'))));
  return { limits, account, token, adminToken, stateFile: need('GATEWAY_STATE_FILE'), gatewayHost, gatewayPort, lockStaleAfterMs: env.GATEWAY_LOCK_STALE_MS ? Number(env.GATEWAY_LOCK_STALE_MS) : undefined, ibHost: env.IB_HOST ?? '127.0.0.1', ibPort, ibClientId };
}

export interface Daemon { port: number; gateway: RiskGateway; broker: IbkrBroker; stop(): Promise<void> }

/**
 * Wires IB Gateway -> IbkrBroker + IbkrQuotes -> RiskGateway -> HTTP server, in that order, and fails before listening
 * if any piece is wrong (not logged in, wrong account, state corrupt, another gateway running).
 */
export async function startDaemon(s: DaemonSettings, log: (line: Record<string, unknown>) => void = (l) => console.log(JSON.stringify(l)), client?: IbClient, opts: { now?: () => number } = {}): Promise<Daemon> {
  for (const n of s.limits.notes) log({ level: 'warn', msg: 'config note', note: n });
  const ib = client ?? new StoqeyClient(s.ibHost, s.ibPort, s.ibClientId);
  const broker = new IbkrBroker(ib, { accountId: s.account, autoReconnectMs: 5_000 });
  await broker.connect();
  log({ level: 'info', msg: 'connected to IB', account: s.account, port: s.ibPort });
  const quotes = new IbkrQuotes(ib, s.limits.allowedSymbols, { firstTickWaitMs: 1_500, now: opts.now });
  quotes.start();
  let gateway: RiskGateway;
  let server: ReturnType<typeof createGatewayServer>;
  let port: number;
  try {
    gateway = new RiskGateway({ broker, quotes, limits: s.limits, accountId: s.account, stateFile: new StateFile(s.stateFile, { staleAfterMs: s.lockStaleAfterMs }), now: opts.now });
    server = createGatewayServer({ gateway, token: s.token, adminToken: s.adminToken, host: s.gatewayHost, port: s.gatewayPort, log });
    port = await server.start();
  } catch (e) {
    // do not leave a half-started process holding the IB session
    quotes.stop();
    broker.disconnect();
    throw e;
  }
  log({ level: 'info', msg: 'gateway listening', host: s.gatewayHost, port });
  return {
    port, gateway, broker,
    async stop() { await server.stop(); quotes.stop(); broker.disconnect(); },
  };
}
