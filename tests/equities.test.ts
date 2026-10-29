import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type pg from 'pg';
import { closePool, resetDb } from './dbhelper';
import { FakeBroker } from '../src/broker/fake';
import { BrokerExecutor } from '../src/broker/executor';
import { PostgresIntentStore } from '../src/broker/store';
import type { OrderIntent } from '../src/broker/types';
import { parseGatewayConfig } from '../src/gateway/config';
import { StaticQuotes } from '../src/gateway/quotes';
import { RiskGateway } from '../src/gateway/risk';
import { StateFile } from '../src/gateway/state';
import { createGatewayServer } from '../src/gateway/server';
import { GatewayBroker } from '../src/gateway/client';
import { ProbeStrategy, sizeIdea } from '../src/equities/strategy';
import { Runner } from '../src/equities/runner';

const EXAMPLE = JSON.parse(readFileSync(join(__dirname, '..', 'config', 'broker-risk.example.json'), 'utf8'));
const limits = parseGatewayConfig(EXAMPLE);
const dir = mkdtempSync(join(tmpdir(), 'eq-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
let pool: pg.Pool;
beforeEach(async () => { pool = await resetDb(); });
afterAll(async () => { await closePool(); });

const OPEN = Date.UTC(2026, 9, 27, 15, 0); // Tue 27 Oct 2026, 11:00 New York (EDT)
const SUNDAY = Date.UTC(2026, 9, 25, 15, 0);

describe('sizing', () => {
  const q = (bid: bigint, ask: bigint) => ({ bidMinor: bid, askMinor: ask });
  it('sizes to the per-trade risk net of fees, then caps at the per-position limit', () => {
    // $10.00 share, 2% stop = 20c a share. Risk budget 1000 - 2*100 = 800c -> 40 shares, but the position cap (8335c) allows 8.
    const s = sizeIdea({ instrumentId: 'AAA', stopPct: 2, targetPct: 3 }, q(999n, 1000n), limits)!;
    expect(s).toMatchObject({ quantity: 8n, limit: 1000n, stop: 980n, target: 1030n });
    expect(s.quantity * (s.limit - s.stop) + 2n * limits.feeReserveMinor).toBeLessThanOrEqual(limits.perTradeRiskMinor);
  });
  it('the risk budget binds when the stop is wide: 10% stop on $10 = 100c/share -> 8 shares by risk', () => {
    const s = sizeIdea({ instrumentId: 'AAA', stopPct: 10, targetPct: 15 }, q(999n, 1000n), limits)!;
    expect(s.quantity).toBe(8n); // min(800/100, 8335/1000) = 8
    const w = sizeIdea({ instrumentId: 'AAA', stopPct: 20, targetPct: 30 }, q(999n, 1000n), limits)!;
    expect(w.quantity).toBe(4n); // 800/200 = 4 by risk
  });
  it('rounds the stop away from the limit, so the sized risk is never understated', () => {
    // 2% of 1003c = 20.06c: the stop must be 21c below (982), not 20c (983)
    const s = sizeIdea({ instrumentId: 'AAA', stopPct: 2, targetPct: 3 }, q(1002n, 1003n), limits)!;
    expect(s.stop).toBe(982n);
  });
  it('returns null when one share does not fit the per-position cap', () => {
    expect(sizeIdea({ instrumentId: 'AAA', stopPct: 2, targetPct: 3 }, q(9_999n, 10_000n), limits)).toBeNull(); // $100/share > $83.35
  });
  it('returns null when the stop would sit at or above the bid', () => {
    expect(sizeIdea({ instrumentId: 'AAA', stopPct: 2, targetPct: 3 }, q(950n, 1000n), limits)).toBeNull(); // stop 980 >= bid 950
  });
});

describe('probe strategy', () => {
  const ctx = (over: Record<string, unknown> = {}) => ({
    nowMs: OPEN, day: '2026-10-27', cashMinor: 50_000n, held: new Set<string>(), attemptedToday: new Set<string>(),
    quotes: new Map([['AAA', { bidMinor: 999n, askMinor: 1000n }], ['BBB', { bidMinor: 999n, askMinor: 1000n }]]), limits, ...over,
  });
  it('proposes the first allowed symbol that is flat, untried and quoted', () => {
    expect(new ProbeStrategy().propose(ctx() as never).map((i) => i.instrumentId)).toEqual(['AAA']);
    expect(new ProbeStrategy().propose(ctx({ held: new Set(['AAA']) }) as never).map((i) => i.instrumentId)).toEqual(['BBB']);
    expect(new ProbeStrategy().propose(ctx({ attemptedToday: new Set(['AAA', 'BBB']) }) as never)).toEqual([]);
  });
  it('never proposes a symbol that is not allowlisted or has no quote', () => {
    expect(new ProbeStrategy({ symbols: ['ZZZ'] }).propose(ctx() as never)).toEqual([]);
    expect(new ProbeStrategy().propose(ctx({ quotes: new Map() }) as never)).toEqual([]);
  });
});

describe('runner against the real gateway', () => {
  async function setup(over: { startMs?: number } = {}) {
    const fake = new FakeBroker('acct', 'USD', 50_000n);
    const clock = { now: over.startMs ?? OPEN };
    const quotes = new StaticQuotes();
    quotes.set('AAA', '1000', clock.now); fake.tick('AAA', '1000');
    const gw = new RiskGateway({ broker: fake, quotes, limits, accountId: 'acct', stateFile: new StateFile(join(dir, `s-${Math.random().toString(36).slice(2)}.json`)), now: () => clock.now });
    const srv = createGatewayServer({ gateway: gw, token: 'w'.repeat(32), adminToken: 'a'.repeat(32), evaluateEveryMs: 0 });
    const port = await srv.start();
    const broker = await GatewayBroker.connect(`http://127.0.0.1:${port}`, 'w'.repeat(32));
    const store = new PostgresIntentStore(pool);
    await store.ensureAccount('acct', 'USD');
    const logs: Array<[string, string, Record<string, unknown> | undefined]> = [];
    const runner = new Runner({
      broker, executor: new BrokerExecutor(broker, store, { inflightGraceMs: 0 }), strategy: new ProbeStrategy(), limits, accountId: 'acct', now: () => clock.now,
      alreadyTried: async (cid) => (await pool.query(`select 1 from broker_order_intents where account_id='acct' and client_order_id=$1`, [cid])).rowCount === 1,
      openIntents: async () => (await pool.query(`select intent from broker_order_intents where account_id='acct' and status in ('SUBMITTING','UNKNOWN','ACCEPTED','PART_FILLED')`)).rows.map((r) => r.intent as OrderIntent),
      log: (l, m, f) => logs.push([l, m, f]),
    });
    return { fake, clock, quotes, gw, srv, runner, logs };
  }

  it('sends one protected entry through the gateway, and never sends the same day-symbol twice', async () => {
    const w = await setup();
    try {
      const r1 = await w.runner.tick();
      expect(r1.submitted).toBe('ogen-2026-10-27-AAA');
      const row = (await pool.query(`select status, intent from broker_order_intents where client_order_id='ogen-2026-10-27-AAA'`)).rows[0];
      expect(row.intent).toMatchObject({ kind: 'BUY_BRACKET', quantity: '8', entryLimitMinor: '1000', stopMinor: '980', targetMinor: '1030' });
      expect(await w.fake.getOrder('acct', 'ogen-2026-10-27-AAA')).not.toBeNull();
      const r2 = await w.runner.tick();
      expect(r2.submitted).toBeUndefined(); // nothing else is quoted, and AAA is already tried
      expect((await pool.query(`select count(*)::int as n from broker_order_intents`)).rows[0].n).toBe(1);
    } finally { await w.srv.stop(); }
  });

  it('does nothing when the market is closed', async () => {
    const w = await setup({ startMs: SUNDAY });
    try {
      expect((await w.runner.tick()).skipped).toBe('MARKET_CLOSED');
      expect((await pool.query(`select count(*)::int as n from broker_order_intents`)).rows[0].n).toBe(0);
    } finally { await w.srv.stop(); }
  });

  it('ignores a stale quote', async () => {
    const w = await setup();
    try {
      w.quotes.set('AAA', '1000', OPEN - limits.quoteMaxAgeMs - 1_000);
      const r = await w.runner.tick();
      expect(r.submitted).toBeUndefined();
      expect((await pool.query(`select count(*)::int as n from broker_order_intents`)).rows[0].n).toBe(0);
    } finally { await w.srv.stop(); }
  });

  it('a refusal by the gateway is recorded once and not retried every tick', async () => {
    const w = await setup();
    try {
      w.quotes.set('AAA', '1000', OPEN, { bid: '990', ask: '1000' }); // ~100 bps spread, limit is 50
      const r1 = await w.runner.tick();
      expect(r1.refused).toMatch(/SPREAD/);
      const r2 = await w.runner.tick();
      expect(r2.refused).toBeUndefined();
      expect(r2.submitted).toBeUndefined();
    } finally { await w.srv.stop(); }
  });

  it('once the entry fills, the next tick follows its state and does not enter that symbol again', async () => {
    const w = await setup();
    try {
      await w.runner.tick();
      w.fake.fill('ogen-2026-10-27-AAA', '8', '1000');
      const r = await w.runner.tick();
      expect(r.refreshed).toBe(1);
      const st = (await pool.query(`select status from broker_order_intents where client_order_id='ogen-2026-10-27-AAA'`)).rows[0].status;
      expect(['FILLED', 'PART_FILLED']).toContain(st);
      expect(r.submitted).toBeUndefined();
    } finally { await w.srv.stop(); }
  });
});
