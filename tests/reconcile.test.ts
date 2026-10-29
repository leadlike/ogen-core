import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type pg from 'pg';
import { closePool, resetDb } from './dbhelper';
import { FakeBroker } from '../src/broker/fake';
import { BrokerExecutor } from '../src/broker/executor';
import { PostgresIntentStore } from '../src/broker/store';
import { BrokerBooks, Reconciler, type ReconcileResult } from '../src/broker/reconcile';
import type { Broker, BuyBracketIntent, CloseIntent, Execution } from '../src/broker/types';
import { parseGatewayConfig } from '../src/gateway/config';
import { StaticQuotes } from '../src/gateway/quotes';
import { RiskGateway } from '../src/gateway/risk';
import { StateFile } from '../src/gateway/state';
import { createGatewayServer } from '../src/gateway/server';
import { GatewayBroker } from '../src/gateway/client';

const EXAMPLE = JSON.parse(readFileSync(join(__dirname, '..', 'config', 'broker-risk.example.json'), 'utf8'));
const dir = mkdtempSync(join(tmpdir(), 'rec-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const buy = (id: string, over: Partial<BuyBracketIntent> = {}): BuyBracketIntent => ({
  kind: 'BUY_BRACKET', mode: 'BROKER_PAPER', accountId: 'acct', clientOrderId: id, instrumentId: 'AAA', currency: 'USD',
  quantity: '3', entryLimitMinor: '1000', stopMinor: '900', targetMinor: '1250', ...over,
});
const close = (id: string, instrumentId = 'AAA', quantity = '3'): CloseIntent => ({
  kind: 'CLOSE', mode: 'BROKER_PAPER', accountId: 'acct', clientOrderId: id, instrumentId, currency: 'USD', quantity,
});

let pool: pg.Pool;
beforeEach(async () => { pool = await resetDb(); });
afterAll(async () => { await closePool(); });

async function world(opts: { broker?: Broker; fake?: FakeBroker; tolerance?: bigint; unresolvedMs?: number; prefixes?: string[] } = {}) {
  const fake = opts.fake ?? new FakeBroker('acct', 'USD', 50_000n);
  let t = 1_000_000;
  fake.nowMs = () => (t += 1_000);
  const store = new PostgresIntentStore(pool);
  await store.ensureAccount('acct', 'USD');
  const books = new BrokerBooks(pool, 'acct');
  await books.setBaseline(50_000n, 'test start');
  const halts: string[] = [];
  const mk = (broker: Broker, halt?: (r: string) => Promise<void>) => new Reconciler({
    broker, pool, accountId: 'acct', currency: 'USD',
    allowedCashVarianceMinor: opts.tolerance ?? 5n, unresolvedOrderAfterMs: opts.unresolvedMs ?? 300_000, executionOverlapMs: 60_000,
    ownOrderPrefixes: opts.prefixes, halt: halt ?? (async (r) => { halts.push(r); }),
  });
  const rec = mk(opts.broker ?? fake);
  const exec = new BrokerExecutor(fake, store, { inflightGraceMs: 0 });
  return { fake, store, books, halts, rec, mk, exec };
}
const codes = (r: ReconcileResult) => r.findings.map((f) => f.code).sort();

describe('books match the broker', () => {
  it('stays OK through a fill with fees, a stop-out, and a close', async () => {
    const w = await world();
    w.fake.feeMinor = 100n; // 1 USD per execution
    await w.exec.submit(buy('b1'));
    w.fake.fill('b1', '3', '1000');
    expect((await w.rec.run()).status).toBe('OK');
    w.fake.tick('AAA', '900'); // stop sells 3 @ 900
    await w.exec.submit(buy('b2', { instrumentId: 'BBB' }));
    w.fake.fill('b2', '3', '1000');
    w.fake.tick('BBB', '1100');
    await w.exec.submit(close('c1', 'BBB', '2'));
    const r = await w.rec.run();
    expect(r.status).toBe('OK');
    expect(r.expected.cashMinor).toBe(r.observed.cashMinor);
    expect(r.expected.positions).toEqual({ BBB: '1' });
    expect(w.halts).toEqual([]);
  });

  it('is idempotent: re-reading overlapping executions stores each one once', async () => {
    const w = await world();
    await w.exec.submit(buy('b1'));
    w.fake.fill('b1', '3', '1000');
    const first = await w.rec.run();
    const second = await w.rec.run();
    expect([first.newExecutions, second.newExecutions]).toEqual([1, 0]);
    expect((await pool.query('select count(*)::int as n from broker_executions')).rows[0].n).toBe(1);
  });

  it('a new Reconciler (restart) continues from the stored books', async () => {
    const w = await world();
    await w.exec.submit(buy('b1'));
    w.fake.fill('b1', '3', '1000');
    await w.rec.run();
    w.fake.tick('AAA', '1300');
    const restarted = w.mk(w.fake);
    const r = await restarted.run();
    expect([r.status, r.newExecutions]).toEqual(['OK', 1]);
  });
});

describe('disagreements freeze entries', () => {
  it('cash within the tolerance passes; one cent beyond it halts', async () => {
    const w = await world({ tolerance: 5n });
    w.fake.skimCash(5n);
    expect((await w.rec.run()).status).toBe('OK');
    w.fake.skimCash(1n); // drift now 6
    const r = await w.rec.run();
    expect(codes(r)).toEqual(['CASH_DRIFT']);
    expect(r.halted).toBe(true);
    expect(w.halts).toHaveLength(1);
    expect(w.halts[0]).toContain('CASH_DRIFT');
  });

  it('a trade made outside our order ids is flagged, even though the books still balance', async () => {
    const w = await world();
    w.fake.externalTrade('ZZZ', 'BUY', '2', '500');
    const r = await w.rec.run();
    expect(codes(r)).toEqual(['EXTERNAL_EXECUTION']);
    expect(w.halts).toHaveLength(1);
  });

  it('orders the gateway itself placed are recognised by prefix, and only by prefix', async () => {
    const fake = new FakeBroker('acct', 'USD', 50_000n);
    const w = await world({ fake, prefixes: ['gw-flatten-'] });
    await w.exec.submit(buy('b1'));
    fake.fill('b1', '3', '1000');
    fake.tick('AAA', '1100');
    await fake.place(close('gw-flatten-2026-10-27-AAA')); // bypasses our intents, as the gateway's flatten does
    expect((await w.rec.run()).status).toBe('OK');
    // the same books read without the prefix: that order now looks foreign
    const strict = new Reconciler({ broker: fake, pool, accountId: 'acct', currency: 'USD', allowedCashVarianceMinor: 5n, unresolvedOrderAfterMs: 300_000, executionOverlapMs: 60_000, halt: async () => undefined });
    expect(codes(await strict.run())).toEqual(['EXTERNAL_EXECUTION']);
  });

  it('an execution the broker never reported shows up as cash and position drift', async () => {
    const fake = new FakeBroker('acct', 'USD', 50_000n);
    const forgetful: Broker = {
      capabilities: fake.capabilities,
      account: (a) => fake.account(a), positions: (a) => fake.positions(a), place: (i) => fake.place(i),
      getOrder: (a, c) => fake.getOrder(a, c), cancel: (a, c) => fake.cancel(a, c),
      executions: async (a, s) => (await fake.executions(a, s)).filter((e) => e.executionId !== 'fake-exec-1'),
    };
    const w = await world({ fake, broker: forgetful });
    await w.exec.submit(buy('b1'));
    fake.fill('b1', '3', '1000');
    const r = await w.rec.run();
    expect(codes(r)).toEqual(['CASH_DRIFT', 'POSITION_MISMATCH']);
    expect(r.status).toBe('MISMATCH');
  });

  it('an already stored execution that later comes back different is flagged', async () => {
    const fake = new FakeBroker('acct', 'USD', 50_000n);
    let tamper = false;
    const rewriting: Broker = {
      capabilities: fake.capabilities,
      account: (a) => fake.account(a), positions: (a) => fake.positions(a), place: (i) => fake.place(i),
      getOrder: (a, c) => fake.getOrder(a, c), cancel: (a, c) => fake.cancel(a, c),
      executions: async (a, s) => (await fake.executions(a, s)).map((e: Execution) => (tamper ? { ...e, priceMinor: '999' } : e)),
    };
    const w = await world({ fake, broker: rewriting });
    await w.exec.submit(buy('b1'));
    fake.fill('b1', '3', '1000');
    expect((await w.rec.run()).status).toBe('OK');
    tamper = true;
    expect(codes(await w.rec.run())).toContain('EXECUTION_CONTENT_CHANGED');
  });

  it('an order left unresolved for too long counts as unaccounted exposure', async () => {
    const fake = new FakeBroker('acct', 'USD', 50_000n);
    fake.scenario = 'TIMEOUT_BEFORE_ACCEPT';
    const w = await world({ fake, unresolvedMs: 10 });
    await expect(w.exec.submit(buy('lost'))).rejects.toThrow('UNCERTAIN');
    await new Promise((r) => setTimeout(r, 30));
    const r = await w.rec.run();
    expect(codes(r)).toEqual(['UNRESOLVED_ORDER']);
  });

  it('cannot run without a starting balance, and then records nothing', async () => {
    const fake = new FakeBroker('acct', 'USD', 50_000n);
    await new PostgresIntentStore(pool).ensureAccount('acct', 'USD');
    const rec = new Reconciler({ broker: fake, pool, accountId: 'acct', currency: 'USD', allowedCashVarianceMinor: 5n, unresolvedOrderAfterMs: 1000, executionOverlapMs: 0, halt: async () => undefined });
    await expect(rec.run()).rejects.toThrow('BASELINE_MISSING');
    expect((await pool.query('select count(*)::int as n from broker_reconciliations')).rows[0].n).toBe(0);
  });

  it('if the gateway cannot be told to halt, the run fails loudly but the mismatch is already on record', async () => {
    const w = await world();
    w.fake.skimCash(500n);
    const rec = w.mk(w.fake, async () => { throw new Error('gateway down'); });
    await expect(rec.run()).rejects.toThrow('HALT_FAILED');
    const rows = (await pool.query('select status from broker_reconciliations')).rows;
    expect(rows).toEqual([{ status: 'MISMATCH' }]);
  });
});

describe('the books themselves', () => {
  it('every run is recorded, and the records cannot be altered', async () => {
    const w = await world();
    await w.exec.submit(buy('b1'));
    w.fake.fill('b1', '3', '1000');
    await w.rec.run(); await w.rec.run();
    expect((await pool.query('select count(*)::int as n from broker_reconciliations')).rows[0].n).toBe(2);
    await expect(pool.query(`update broker_reconciliations set status='OK'`)).rejects.toThrow('append-only');
    await expect(pool.query(`delete from broker_executions`)).rejects.toThrow('append-only');
    await expect(pool.query(`update broker_baselines set cash_minor=1`)).rejects.toThrow('append-only');
  });
  it('the starting balance can be repeated but never changed', async () => {
    const w = await world();
    await w.books.setBaseline(50_000n, 'again');
    await expect(w.books.setBaseline(60_000n, 'edited')).rejects.toThrow('BASELINE_ALREADY_SET');
  });
});

describe('end to end with the real gateway', () => {
  async function gatewayWorld() {
    const fake = new FakeBroker('acct', 'USD', 50_000n);
    const quotes = new StaticQuotes();
    const clock = { now: Date.UTC(2026, 9, 27, 15) };
    quotes.set('AAA', '1000', clock.now);
    quotes.set('BBB', '1000', clock.now);
    fake.tick('AAA', '1000');
    const statePath = join(dir, `gw-${Math.random().toString(36).slice(2)}.json`);
    const limits = parseGatewayConfig(EXAMPLE);
    const make = () => new RiskGateway({ broker: fake, quotes, limits, accountId: 'acct', stateFile: new StateFile(statePath), now: () => clock.now });
    const gw = make();
    const srv = createGatewayServer({ gateway: gw, token: 'w', adminToken: 'a', evaluateEveryMs: 0 });
    const port = await srv.start();
    const url = `http://127.0.0.1:${port}`;
    const worker = await GatewayBroker.connect(url, 'w');
    const store = new PostgresIntentStore(pool);
    await store.ensureAccount('acct', 'USD');
    await new BrokerBooks(pool, 'acct').setBaseline(50_000n, 'test start');
    const rec = new Reconciler({
      broker: worker, pool, accountId: 'acct', currency: 'USD', allowedCashVarianceMinor: 5n, unresolvedOrderAfterMs: 300_000,
      executionOverlapMs: 60_000, ownOrderPrefixes: ['gw-flatten-'], halt: (r) => worker.halt(r),
    });
    return { gw, statePath, fake, quotes, clock, srv, url, worker, rec, make, store, exec: new BrokerExecutor(worker, store, { inflightGraceMs: 0 }) };
  }

  it('a mismatch found by the worker stops the gateway from accepting entries, across a restart, until an operator resumes', async () => {
    const g = await gatewayWorld();
    try {
      expect((await g.exec.submit(buy('ok1'))).status).toBe('ACCEPTED');
      g.fake.fill('ok1', '3', '1000');
      expect((await g.rec.run()).status).toBe('OK');

      g.fake.skimCash(500n); // five dollars vanish with no execution behind them
      const bad = await g.rec.run();
      expect(codes(bad)).toEqual(['CASH_DRIFT']);
      expect(bad.halted).toBe(true);

      // a perfectly valid order is now refused by the gateway, whatever the worker believes
      await expect(g.exec.submit(buy('after', { instrumentId: 'BBB' }))).rejects.toThrow('BREAKER_RECONCILIATION');
      // and the freeze is in the gateway's own file, so a new gateway process keeps it
      // (read from the file with no lock: a closed gateway no longer sends anything, by design)
      expect(new StateFile(g.statePath).load()?.breakers.reconciliation?.reason).toContain('CASH_DRIFT');

      // closing positions stays possible
      g.fake.tick('AAA', '1100');
      expect((await g.exec.submit(close('c1'))).status).toBe('FILLED');

      // the worker token cannot lift the freeze; the operator token can
      const lift = (tok: string) => fetch(`${g.url}/admin/resume-reconciliation`, { method: 'POST', headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' }, body: JSON.stringify({ note: 'cash restored by hand' }) });
      expect((await lift('w')).status).toBe(401);
      expect((await lift('a')).status).toBe(200);
    } finally { await g.srv.stop(); }
  });

  it('a foreign execution keeps flagging until acknowledged, and a clean run never lifts the freeze by itself', async () => {
    const g = await gatewayWorld();
    try {
      g.fake.externalTrade('ZZZ', 'BUY', '1', '500');
      expect(codes(await g.rec.run())).toEqual(['EXTERNAL_EXECUTION']);
      expect(codes(await g.rec.run())).toEqual(['EXTERNAL_EXECUTION']); // not forgotten after being stored
      const books = new BrokerBooks(pool, 'acct');
      await books.acknowledge('fake-exec-1', 'my own manual trade, fine');
      expect((await g.rec.run()).status).toBe('OK');
      await expect(g.exec.submit(buy('x'))).rejects.toThrow('BREAKER_RECONCILIATION'); // reconciling cleanly is not permission
      const lift = await fetch(`${g.url}/admin/resume-reconciliation`, { method: 'POST', headers: { authorization: 'Bearer a', 'content-type': 'application/json' }, body: JSON.stringify({ note: 'acknowledged ZZZ' }) });
      expect(lift.status).toBe(200);
      // the accepted foreign holding must be priceable for the gateway to compute equity
      await expect(g.exec.submit(buy('y'))).rejects.toThrow('EQUITY_UNAVAILABLE');
      g.quotes.set('ZZZ', '500', g.clock.now);
      expect((await g.exec.submit(buy('z'))).status).toBe('ACCEPTED');
    } finally { await g.srv.stop(); }
  });
});
