import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { BrokerExecutor } from '../broker/executor';
import { PostgresIntentStore } from '../broker/store';
import { BrokerBooks, Reconciler } from '../broker/reconcile';
import { GatewayBroker } from '../gateway/client';
import { parseGatewayConfig } from '../gateway/config';
import { migrate } from '../store/migrate';
import { createPool } from '../store/store';
import { privateAddress } from '../gateway/daemon';
import { databaseUrl, gatewayUrl } from './config';
import { ProbeStrategy } from './strategy';
import { Runner } from './runner';
import type { OrderIntent } from '../broker/types';

const env = z.object({
  DATABASE_URL: z.string().min(1).optional(),
  DB_HOST: z.string().optional(), DB_NAME: z.string().optional(), DB_USER: z.string().optional(), DB_PASSWORD: z.string().optional(), DB_PORT: z.string().optional(),
  GATEWAY_URL: z.string().min(1),
  GATEWAY_TOKEN: z.string().min(32),
  IB_ACCOUNT: z.string().regex(/^DU[0-9]+$/, 'paper accounts only (DU…)'),
  BROKER_RISK_CONFIG: z.string().optional(),
  BROKER_RISK_CONFIG_JSON: z.string().optional(),
  TICK_MS: z.coerce.number().int().min(5_000).default(30_000),
  RECONCILE_EVERY_MS: z.coerce.number().int().min(60_000).default(300_000),
});

const log = (level: 'info' | 'warn' | 'error', msg: string, f: Record<string, unknown> = {}) =>
  (level === 'error' ? process.stderr : process.stdout).write(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...f }) + '\n');

/** `npm run equities` — the strategy worker. Talks only to the risk gateway; holds no broker credentials. */
async function main(): Promise<void> {
  const e = env.parse(process.env);
  if (e.BROKER_RISK_CONFIG && e.BROKER_RISK_CONFIG_JSON) throw new Error('ENV_CONFLICT: set one of BROKER_RISK_CONFIG, BROKER_RISK_CONFIG_JSON');
  const limits = parseGatewayConfig(JSON.parse(e.BROKER_RISK_CONFIG_JSON ?? readFileSync(e.BROKER_RISK_CONFIG ?? '', 'utf8')));
  const pool = createPool(databaseUrl(process.env), 5);
  await migrate(pool);
  const broker = await GatewayBroker.connect(gatewayUrl(e.GATEWAY_URL, privateAddress), e.GATEWAY_TOKEN);
  const acct = await broker.account(e.IB_ACCOUNT);
  if (acct.currency !== limits.currency) throw new Error(`CURRENCY_MISMATCH: account ${acct.currency}, limits ${limits.currency}`);
  const books = new BrokerBooks(pool, e.IB_ACCOUNT);
  await new PostgresIntentStore(pool).ensureAccount(e.IB_ACCOUNT, acct.currency);
  await books.setBaseline(BigInt(acct.cashMinor), 'baseline at first worker start'); // refuses a different value later: never silently re-based

  const reconciler = new Reconciler({
    broker, pool, accountId: e.IB_ACCOUNT, currency: acct.currency,
    allowedCashVarianceMinor: limits.reconciliation.allowedCashVarianceMinor, unresolvedOrderAfterMs: limits.reconciliation.unresolvedOrderAfterMs,
    executionOverlapMs: limits.reconciliation.executionOverlapMs, ownOrderPrefixes: ['gw-flatten-'], halt: (r) => broker.halt(r),
  });
  const runner = new Runner({
    broker, executor: new BrokerExecutor(broker, new PostgresIntentStore(pool)), strategy: new ProbeStrategy(), limits, accountId: e.IB_ACCOUNT,
    alreadyTried: async (cid) => (await pool.query(`select 1 from broker_order_intents where mode='BROKER_PAPER' and account_id=$1 and client_order_id=$2`, [e.IB_ACCOUNT, cid])).rowCount === 1,
    openIntents: async () => (await pool.query(`select intent from broker_order_intents where mode='BROKER_PAPER' and account_id=$1 and status in ('SUBMITTING','UNKNOWN','ACCEPTED','PART_FILLED')`, [e.IB_ACCOUNT])).rows.map((r) => r.intent as OrderIntent),
    reconcile: () => reconciler.run(), reconcileEveryMs: e.RECONCILE_EVERY_MS, log,
  });

  let stopping = false;
  const quit = (sig: string) => { stopping = true; log('info', 'shutting down', { sig }); };
  process.on('SIGTERM', () => quit('SIGTERM'));
  process.on('SIGINT', () => quit('SIGINT'));
  log('info', 'worker started', { strategy: 'probe-v1', account: 'DU…', tickMs: e.TICK_MS });
  while (!stopping) {
    try { const r = await runner.tick(); log('info', 'tick', { ...r }); } catch (err) { log('error', 'tick failed', { error: (err as Error).message }); }
    await new Promise((res) => setTimeout(res, e.TICK_MS));
  }
  await pool.end();
}
main().catch((err) => { process.stderr.write(JSON.stringify({ level: 'fatal', msg: (err as Error).message }) + '\n'); process.exit(1); });
