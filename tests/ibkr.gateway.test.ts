import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type pg from 'pg';
import { closePool, resetDb } from './dbhelper';
import { FakeIb } from './fakeib';
import { IbkrBroker } from '../src/broker/ibkr/broker';
import { IbkrQuotes } from '../src/broker/ibkr/quotes';
import { BrokerExecutor } from '../src/broker/executor';
import { PostgresIntentStore } from '../src/broker/store';
import { BrokerBooks, Reconciler } from '../src/broker/reconcile';
import { OrderRefused, type BuyBracketIntent, type CloseIntent } from '../src/broker/types';
import { privateAddress, readSettings, startDaemon } from '../src/gateway/daemon';
import { GatewayBroker } from '../src/gateway/client';

const ACCT = 'DU1234567';
const CONFIG_PATH = join(__dirname, '..', 'config', 'broker-risk.example.json');
const dir = mkdtempSync(join(tmpdir(), 'ibgw-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const T0 = Date.UTC(2026, 9, 27, 15, 0, 0); // Tue 11:00 New York

const buy = (id: string, over: Partial<BuyBracketIntent> = {}): BuyBracketIntent => ({
  kind: 'BUY_BRACKET', mode: 'BROKER_PAPER', accountId: ACCT, clientOrderId: id, instrumentId: 'SCHD', currency: 'USD',
  quantity: '3', entryLimitMinor: '2500', stopMinor: '2400', targetMinor: '2800', ...over,
});
const close = (id: string, quantity = '3'): CloseIntent => ({ kind: 'CLOSE', mode: 'BROKER_PAPER', accountId: ACCT, clientOrderId: id, instrumentId: 'SCHD', currency: 'USD', quantity });

const env = (over: Record<string, string | undefined> = {}): NodeJS.ProcessEnv => ({
  GATEWAY_TOKEN: 'w'.repeat(32), GATEWAY_ADMIN_TOKEN: 'a'.repeat(32), IB_ACCOUNT: ACCT, IB_PORT: '4004',
  BROKER_RISK_CONFIG: CONFIG_PATH, GATEWAY_STATE_FILE: join(dir, 'state.json'), GATEWAY_HOST: '127.0.0.1', GATEWAY_PORT: '0', ...over,
}) as unknown as NodeJS.ProcessEnv;
const code = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e instanceof OrderRefused ? e.code : `ERR:${(e as Error).message}`; } return 'OK'; };

describe('quotes from IB ticks', () => {
  function qworld(now = { v: T0 }) {
    const ib = new FakeIb();
    const q = new IbkrQuotes(ib, new Set(['SCHD', 'XLF']), { now: () => now.v });
    q.start();
    const id = (sym: string) => [...ib.mktData].find(([, s]) => s === sym)![0];
    return { ib, q, id, now };
  }
  it('subscribes only to the allowed symbols', () => {
    const { ib } = qworld();
    expect([...ib.mktData.values()].sort()).toEqual(['SCHD', 'XLF']);
  });
  it('has no quote until both bid and ask have arrived', async () => {
    const { ib, q, id } = qworld();
    expect(await q.quote('SCHD')).toBeNull();
    ib.tick(id('SCHD'), 1, 499.99);
    expect(await q.quote('SCHD')).toBeNull();
    ib.tick(id('SCHD'), 2, 500.02);
    expect(await q.quote('SCHD')).toEqual({ priceMinor: '50000', asOfMs: T0, bidMinor: '49999', askMinor: '50002' });
  });
  it('widens the spread to the cent: bid rounded down, ask rounded up', async () => {
    const { ib, q, id } = qworld();
    ib.tick(id('SCHD'), 1, 10.004); ib.tick(id('SCHD'), 2, 10.016);
    const r = (await q.quote('SCHD'))!;
    expect([r.bidMinor, r.askMinor]).toEqual(['1000', '1002']);
  });
  it('ignores delayed ticks entirely, so a missing subscription means no quote', async () => {
    const { ib, q, id } = qworld();
    ib.tick(id('SCHD'), 66, 499); ib.tick(id('SCHD'), 67, 501);
    expect(await q.quote('SCHD')).toBeNull();
  });
  it('a delayed tick never refreshes a real-time quote\'s age', async () => {
    const { ib, q, id, now } = qworld();
    ib.tick(id('SCHD'), 1, 500); ib.tick(id('SCHD'), 2, 500.1);
    now.v = T0 + 30_000;
    ib.tick(id('SCHD'), 66, 400); ib.tick(id('SCHD'), 68, 400);
    expect((await q.quote('SCHD'))!.asOfMs).toBe(T0);
  });
  it('a side IB reports as -1 (no quote) is cleared, not read as a price', async () => {
    const { ib, q, id } = qworld();
    ib.tick(id('SCHD'), 1, 500); ib.tick(id('SCHD'), 2, 500.1);
    ib.tick(id('SCHD'), 2, -1);
    expect(await q.quote('SCHD')).toBeNull();
  });
  it('carries the time of the last tick, so staleness is visible to the gateway; size ticks count as life', async () => {
    const { ib, q, id, now } = qworld();
    ib.tick(id('SCHD'), 1, 500); ib.tick(id('SCHD'), 2, 500.1);
    now.v = T0 + 20_000;
    expect((await q.quote('SCHD'))!.asOfMs).toBe(T0);
    ib['emit']('tickSize', id('SCHD'), 0, 100);
    expect((await q.quote('SCHD'))!.asOfMs).toBe(T0 + 20_000);
  });
  it('knows nothing about symbols outside the list, and resubscribes after a reconnect', async () => {
    const { ib, q } = qworld();
    expect(await q.quote('TSLA')).toBeNull();
    ib.mktData.clear();
    ib['emit']('connected');
    expect([...ib.mktData.values()].sort()).toEqual(['SCHD', 'XLF']);
  });
  it('waits a short while for a first tick when asked to', async () => {
    const ib = new FakeIb();
    const q = new IbkrQuotes(ib, new Set(['SCHD']), { firstTickWaitMs: 300 });
    q.start();
    const id = [...ib.mktData.keys()][0]!;
    setTimeout(() => { ib.tick(id, 1, 10); ib.tick(id, 2, 10.01); }, 60);
    expect(await q.quote('SCHD')).not.toBeNull();
  });
});

describe('daemon settings', () => {
  it('accepts a complete paper environment', () => {
    const s = readSettings(env());
    expect(s.account).toBe(ACCT);
    expect(s.limits.allowedSymbols.has('SCHD')).toBe(true);
  });
  it.each([
    ['a missing token', { GATEWAY_TOKEN: undefined }, /ENV_MISSING: GATEWAY_TOKEN/],
    ['a short token', { GATEWAY_TOKEN: 'short' }, /ENV_WEAK_TOKEN/],
    ['identical tokens', { GATEWAY_ADMIN_TOKEN: 'w'.repeat(32) }, /ENV_SAME_TOKENS/],
    ['a live account', { IB_ACCOUNT: 'U1234567' }, /ENV_NOT_PAPER/],
    ['a live port', { IB_PORT: '4003' }, /ENV_NOT_PAPER_PORT/],
    ['the live gateway port', { IB_PORT: '4001' }, /ENV_NOT_PAPER_PORT/],
    ['binding to every interface', { GATEWAY_HOST: '0.0.0.0' }, /ENV_PUBLIC_BIND/],
    ['a public address', { GATEWAY_HOST: '8.8.8.8' }, /ENV_PUBLIC_BIND/],
    ['no state file', { GATEWAY_STATE_FILE: undefined }, /ENV_MISSING: GATEWAY_STATE_FILE/],
    ['no risk config', { BROKER_RISK_CONFIG: undefined }, /ENV_MISSING: BROKER_RISK_CONFIG/],
  ])('refuses %s', (_n, over, re) => {
    expect(() => readSettings(env(over as Record<string, string | undefined>))).toThrow(re);
  });
  it('accepts loopback and private addresses', () => {
    for (const h of ['127.0.0.1', '10.0.3.4', '172.20.1.1', '192.168.1.9', 'localhost']) expect(() => readSettings(env({ GATEWAY_HOST: h }))).not.toThrow();
    for (const h of ['172.32.0.1', '11.0.0.1']) expect(() => readSettings(env({ GATEWAY_HOST: h }))).toThrow(/ENV_PUBLIC_BIND/);
  });
  it('takes the optional lock takeover window and refuses one that is too small to be safe', () => {
    expect(readSettings(env({ GATEWAY_LOCK_STALE_MS: '30000' })).lockStaleAfterMs).toBe(30_000);
    expect(readSettings(env()).lockStaleAfterMs).toBeUndefined();
    expect(() => readSettings(env({ GATEWAY_LOCK_STALE_MS: '1000' }))).toThrow(/GATEWAY_LOCK_STALE_MS/);
    expect(() => readSettings(env({ GATEWAY_LOCK_STALE_MS: 'abc' }))).toThrow(/GATEWAY_LOCK_STALE_MS/);
  });
  it('takes the risk limits inline, and refuses having both an inline config and a file', () => {
    const json = readFileSync(CONFIG_PATH, 'utf8');
    expect(readSettings(env({ BROKER_RISK_CONFIG: undefined, BROKER_RISK_CONFIG_JSON: json })).limits.maxOpenPositions).toBe(3);
    expect(() => readSettings(env({ BROKER_RISK_CONFIG_JSON: json }))).toThrow(/ENV_CONFLICT/);
    expect(() => readSettings(env({ BROKER_RISK_CONFIG: undefined, BROKER_RISK_CONFIG_JSON: '{}' }))).toThrow();
  });
  it('GATEWAY_HOST=auto binds the task\'s single private address, and nothing else', () => {
    const lo = { address: '127.0.0.1', family: 'IPv4', internal: true };
    expect(privateAddress({ lo: [lo], eth1: [{ address: '10.20.3.7', family: 'IPv4', internal: false }] })).toBe('10.20.3.7');
    expect(() => privateAddress({ lo: [lo] })).toThrow(/found none/);
    expect(() => privateAddress({ a: [{ address: '8.8.8.8', family: 'IPv4', internal: false }] })).toThrow(/found none/); // public: ignored
    expect(() => privateAddress({ a: [{ address: '10.0.0.1', family: 'IPv4', internal: false }], b: [{ address: '10.0.0.2', family: 'IPv4', internal: false }] })).toThrow(/found 10.0.0.1, 10.0.0.2/);
    expect(readSettings(env({ GATEWAY_HOST: 'auto' }), undefined, { eth0: [{ address: '10.20.3.7', family: 'IPv4', internal: false }] }).gatewayHost).toBe('10.20.3.7');
  });
  it('refuses a risk config that is invalid', () => {
    expect(() => readSettings(env(), () => '{"capital":{}}')).toThrow();
  });
});

describe('the whole chain: worker -> HTTP gateway -> risk checks -> IbkrBroker -> (fake) TWS', () => {
  async function chain(statePath = join(dir, `s-${Math.random().toString(36).slice(2)}.json`)) {
    const ib = new FakeIb();
    const settings = readSettings(env({ GATEWAY_STATE_FILE: statePath }));
    const d = await startDaemon(settings, () => undefined, ib, { now: () => T0 });
    const worker = await GatewayBroker.connect(`http://127.0.0.1:${d.port}`, 'w'.repeat(32));
    const spy = [...ib.mktData].find(([, s]) => s === 'SCHD')![0];
    ib.tick(spy, 1, 24.99); ib.tick(spy, 2, 25.01);
    return { ib, d, worker, statePath };
  }

  it('a normal entry reaches TWS as a bracket, and its protection is confirmed back through the gateway', async () => {
    const { ib, d, worker } = await chain();
    try {
      const o = await worker.place(buy('c-1'));
      expect(o.status).toBe('ACCEPTED');
      expect(ib.sent.map((s) => s.order.orderRef)).toEqual(['c-1', 'c-1#STP', 'c-1#TGT']);
      ib.fillEntry('c-1', 3, 25);
      expect(await worker.getOrder(ACCT, 'c-1')).toMatchObject({ status: 'FILLED', protectedQuantity: '3' });
      expect(await worker.positions(ACCT)).toEqual([{ instrumentId: 'SCHD', quantity: '3', costMinor: '7500' }]);
    } finally { await d.stop(); }
  });

  it('the gateway\'s limits apply before anything is sent to TWS', async () => {
    const { ib, d, worker } = await chain();
    try {
      expect(await code(worker.place(buy('big', { quantity: '4' })))).toBe('POSITION_TOO_LARGE'); // 4 x 25.00 = 100 > 83.35
      expect(await code(worker.place(buy('sym', { instrumentId: 'TSLA' })))).toBe('SYMBOL_NOT_ALLOWED');
      expect(await code(worker.place(buy('wide', { stopMinor: '2000' })))).toBe('TRADE_RISK_TOO_HIGH');
      expect(ib.sent).toHaveLength(0);
      ib.tick([...ib.mktData].find(([, s]) => s === 'SCHD')![0], 2, 25.5); // spread 1.5 / 25.25 = 594 bps
      expect(await code(worker.place(buy('spread')))).toBe('SPREAD_TOO_WIDE');
      expect(ib.sent).toHaveLength(0);
    } finally { await d.stop(); }
  });

  it('a TWS reject comes back to the worker as a definite refusal', async () => {
    const { ib, d, worker } = await chain();
    try {
      ib.rejectNext = { code: 201, message: 'insufficient buying power' };
      expect(await code(worker.place(buy('rej')))).toMatch(/IB_201/);
    } finally { await d.stop(); }
  });

  it('a close goes through even when every breaker would block an entry', async () => {
    const { ib, d, worker } = await chain();
    try {
      await worker.place(buy('c-2'));
      ib.fillEntry('c-2', 3, 25);
      d.gateway.halt('test freeze');
      await new Promise((r) => setTimeout(r, 20));
      expect(await code(worker.place(buy('after', { instrumentId: 'XLF' })))).toBe('BREAKER_RECONCILIATION');
      expect((await worker.place(close('cl-1'))).status).toBe('ACCEPTED');
    } finally { await d.stop(); }
  });

  it('a second daemon on the same state file refuses to start and does not keep the IB session', async () => {
    const a = await chain();
    try {
      const ib2 = new FakeIb();
      await expect(startDaemon(readSettings(env({ GATEWAY_STATE_FILE: a.statePath })), () => undefined, ib2, { now: () => T0 })).rejects.toThrow(/LOCKED/);
      expect(ib2.connectedNow).toBe(false);
    } finally { await a.d.stop(); }
    expect(existsSync(`${a.statePath}.lock`)).toBe(false);
  });

  it('refuses to start when the paper account is not the one logged in to IB Gateway', async () => {
    const ib = new FakeIb(); ib.accounts = 'DU9999999';
    await expect(startDaemon(readSettings(env({ GATEWAY_STATE_FILE: join(dir, 'x.json') })), () => undefined, ib, { now: () => T0 })).rejects.toThrow(/NOT_LOGGED_IN/);
  });
});

describe('reconciliation against the IB adapter (real PostgreSQL)', () => {
  let pool: pg.Pool;
  beforeEach(async () => { pool = await resetDb(); });
  afterAll(async () => { await closePool(); });

  async function rworld() {
    const ib = new FakeIb();
    const broker = new IbkrBroker(ib, { accountId: ACCT, ackTimeoutMs: 200, requestTimeoutMs: 200, commissionWaitMs: 100 });
    await broker.connect(1000);
    const store = new PostgresIntentStore(pool);
    await store.ensureAccount(ACCT, 'USD');
    await new BrokerBooks(pool, ACCT).setBaseline(50_000n, 'start');
    const halts: string[] = [];
    const rec = new Reconciler({ broker, pool, accountId: ACCT, currency: 'USD', allowedCashVarianceMinor: 5n, unresolvedOrderAfterMs: 300_000, executionOverlapMs: 60_000, halt: async (r) => { halts.push(r); } });
    return { ib, broker, rec, halts, exec: new BrokerExecutor(broker, store, { inflightGraceMs: 0 }) };
  }

  it('books and IB agree through an entry, a stop-out and a close, with real commissions', async () => {
    const w = await rworld();
    await w.exec.submit(buy('r1'));
    w.ib.fillEntry('r1', 3, 25, 1.0);
    expect((await w.rec.run()).status).toBe('OK');
    w.ib.fillStop('r1', 24, 1.0);
    await w.exec.submit(buy('r2', { instrumentId: 'XLF' }));
    w.ib.fillEntry('r2', 3, 30, 1.0);
    await w.exec.submit({ ...close('rc'), instrumentId: 'XLF' });
    w.ib.fillClose('rc', 31, 1.0);
    const r = await w.rec.run();
    expect(r.status).toBe('OK');
    expect(r.expected.cashMinor).toBe(r.observed.cashMinor);
    expect(w.halts).toEqual([]);
  });

  it('cash that moved with no execution behind it freezes the gateway', async () => {
    const w = await rworld();
    await w.exec.submit(buy('r3'));
    w.ib.fillEntry('r3', 3, 25);
    w.ib.cash -= 5; // five dollars gone, no trade
    const r = await w.rec.run();
    expect(r.findings.map((f) => f.code)).toContain('CASH_DRIFT');
    expect(w.halts).toHaveLength(1);
  });

  it('a trade made by hand in the account is flagged', async () => {
    const w = await rworld();
    w.ib.manualTrade('XLF', 'BOT', 1, 30);
    const r = await w.rec.run();
    expect(r.findings.map((f) => f.code)).toContain('EXTERNAL_EXECUTION');
    expect(w.halts).toHaveLength(1);
  });

  it('a missing commission report makes the run fail instead of passing with a wrong fee', async () => {
    const w = await rworld();
    w.ib.withholdCommissions = true;
    await w.exec.submit(buy('r4'));
    w.ib.fillEntry('r4', 3, 25);
    await expect(w.rec.run()).rejects.toThrow(/COMMISSION_PENDING/);
    w.ib.deliverCommissions();
    expect((await w.rec.run()).status).toBe('OK');
  });
});
