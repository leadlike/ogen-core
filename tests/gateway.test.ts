import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type pg from 'pg';
import { closePool, resetDb } from './dbhelper';
import { FakeBroker } from '../src/broker/fake';
import { BrokerExecutor } from '../src/broker/executor';
import { PostgresIntentStore } from '../src/broker/store';
import { OrderRefused, type BuyBracketIntent, type CloseIntent, type OrderIntent } from '../src/broker/types';
import { parseGatewayConfig, type GatewayLimits } from '../src/gateway/config';
import { StaticQuotes } from '../src/gateway/quotes';
import { RiskGateway } from '../src/gateway/risk';
import { StateFile } from '../src/gateway/state';
import { createGatewayServer } from '../src/gateway/server';
import { GatewayBroker } from '../src/gateway/client';

const EXAMPLE = JSON.parse(readFileSync(join(__dirname, '..', 'config', 'broker-risk.example.json'), 'utf8'));
const cfg = (edit: (c: any) => void = () => undefined): GatewayLimits => {
  const c = structuredClone(EXAMPLE);
  c.loss.feeReserveMicroUsd = 0; // most tests reason in whole stop distances; fee tests set it explicitly
  edit(c);
  return parseGatewayConfig(c);
};

const T0 = Date.UTC(2026, 9, 27, 15, 0, 0);
const DAY = 86_400_000;
const dir = mkdtempSync(join(tmpdir(), 'gw-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const buy = (id: string, over: Partial<BuyBracketIntent> = {}): BuyBracketIntent => ({
  kind: 'BUY_BRACKET', mode: 'BROKER_PAPER', accountId: 'acct', clientOrderId: id, instrumentId: 'AAA', currency: 'USD',
  quantity: '3', entryLimitMinor: '1000', stopMinor: '900', targetMinor: '1250', ...over,
});
const close = (id: string, instrumentId = 'AAA', quantity = '3'): CloseIntent => ({
  kind: 'CLOSE', mode: 'BROKER_PAPER', accountId: 'acct', clientOrderId: id, instrumentId, currency: 'USD', quantity,
});

class SlowFake extends FakeBroker {
  constructor(private delayMs: number, ...a: ConstructorParameters<typeof FakeBroker>) { super(...a); }
  override async place(i: OrderIntent) {
    await new Promise((r) => setTimeout(r, this.delayMs));
    return super.place(i);
  }
}

let n = 0;
function setup(opts: { limits?: GatewayLimits; broker?: FakeBroker; path?: string } = {}) {
  const broker = opts.broker ?? new FakeBroker('acct', 'USD', 50_000n);
  const quotes = new StaticQuotes();
  const clock = { now: T0 };
  const path = opts.path ?? join(dir, `state-${++n}.json`);
  const limits = opts.limits ?? cfg();
  const make = () => new RiskGateway({ broker, quotes, limits, accountId: 'acct', stateFile: new StateFile(path), now: () => clock.now });
  /** market moves: the quote AND the broker's price change, so broker-held stops can fire */
  const price = (inst: string, p: string, ageMs = 0) => { quotes.set(inst, p, clock.now - ageMs); broker.tick(inst, p); };
  /** only the gateway's quote source moves (an unrealised mark; the broker's own price and stops are untouched) */
  const q = (inst: string, p: string) => quotes.set(inst, p, clock.now);
  price('AAA', '1000'); price('BBB', '1000'); price('CCC', '1000'); price('DDD', '1000');
  return { broker, quotes, clock, path, limits, gw: make(), make, price, q };
}
const refusal = async (p: Promise<unknown>) => {
  try { await p; } catch (e) { if (e instanceof OrderRefused) return e.code; throw e; }
  return 'ALLOWED';
};

describe('configuration', () => {
  it('turns the agreed numbers into cents', () => {
    const l = cfg();
    expect([l.allocatedMinor, l.perPositionMinor, l.grossExposureMinor, l.perTradeRiskMinor, l.dailyLossMinor, l.maxDrawdownBp]).toEqual([50_000n, 8_335n, 25_000n, 1_000n, 1_000n, 800n]);
    expect(l.maxOpenPositions).toBe(3);
  });
  it('3 positions of 16.67% (250.05 USD) overshoot the 250 USD exposure cap by 5 cents, and says the cap prevails', () => {
    expect(cfg().notes.join(' ')).toMatch(/exceeds maxGrossExposurePct \(25000\) by 5 minor units; the exposure cap prevails/);
    expect(cfg().notes.join(' ')).not.toMatch(/lower figure applies/);
  });
  it('says out loud when the position cap makes the exposure cap unreachable', () => {
    expect(cfg((c) => { c.capital.maxPerPositionPct = 16.66; }).notes.join(' ')).toMatch(/lower figure applies/);
  });
  it('refuses margin, shorting, fractional shares, unknown keys and fractions of a cent', () => {
    expect(() => cfg((c) => { c.account.allowMargin = true; })).toThrow();
    expect(() => cfg((c) => { c.account.allowShort = true; })).toThrow();
    expect(() => cfg((c) => { c.account.allowFractional = true; })).toThrow();
    expect(() => cfg((c) => { c.extra = 1; })).toThrow();
    expect(() => cfg((c) => { c.loss.dailyLossLimitMicroUsd = 10_000_001; })).toThrow(/cents/);
    expect(() => cfg((c) => { c.session.timezone = 'Mars/Base'; })).toThrow(/timezone/);
  });
});

describe('entry checks', () => {
  it('allows a normal bracket and records the decision', async () => {
    const s = setup();
    expect((await s.gw.place(buy('o1'))).status).toBe('ACCEPTED');
    expect(s.broker.placeCalls).toBe(1);
    expect(readFileSync(`${s.path}.audit.jsonl`, 'utf8')).toContain('"decision":"ALLOW"');
  });

  it('refuses a trade whose stop distance risks more than 2% of capital, and sends nothing', async () => {
    const s = setup();
    expect(await refusal(s.gw.place(buy('o1', { stopMinor: '600' })))).toBe('TRADE_RISK_TOO_HIGH'); // (1000-600)*3 = 1200 > 1000
    expect(s.broker.placeCalls).toBe(0);
  });

  it('allows exactly the limits (risk 1000, size 8335) and refuses one cent more', async () => {
    const s = setup();
    const edge = { quantity: '10', entryLimitMinor: '500', stopMinor: '400', targetMinor: '700' }; // risk 1000, notional 5000
    expect(await refusal(s.gw.place(buy('edge', edge)))).toBe('ALLOWED');
    expect(await refusal(s.gw.place(buy('over1', { ...edge, instrumentId: 'BBB', stopMinor: '399' })))).toBe('TRADE_RISK_TOO_HIGH');
  });

  it('allows exactly the size limit (8335 = 16.67% of 500) and refuses 5 cents more', async () => {
    const s = setup();
    s.price('DDD', '2000'); s.price('EEE', '2000');
    const five = { quantity: '5', targetMinor: '2200' };
    expect(await refusal(s.gw.place(buy('size-exact', { ...five, instrumentId: 'DDD', entryLimitMinor: '1667', stopMinor: '1650' })))).toBe('ALLOWED');
    expect(await refusal(s.gw.place(buy('size-over', { ...five, instrumentId: 'EEE', entryLimitMinor: '1668', stopMinor: '1650' })))).toBe('POSITION_TOO_LARGE');
  });

  it('requires a fresh quote: missing, stale and future are all refused', async () => {
    const s = setup();
    s.quotes.clear('AAA');
    expect(await refusal(s.gw.place(buy('a')))).toBe('NO_QUOTE');
    s.price('AAA', '1000', 15_001);
    expect(await refusal(s.gw.place(buy('b')))).toBe('STALE_QUOTE');
    s.price('AAA', '1000', 15_000);
    expect(await refusal(s.gw.place(buy('c')))).toBe('ALLOWED');
    s.quotes.set('BBB', '1000', s.clock.now + 60_000);
    expect(await refusal(s.gw.place(buy('d', { instrumentId: 'BBB' })))).toBe('QUOTE_FROM_THE_FUTURE');
    expect(s.broker.placeCalls).toBe(1);
  });

  it('refuses a stop that the market has already passed', async () => {
    const s = setup();
    s.price('AAA', '880');
    expect(await refusal(s.gw.place(buy('o1')))).toBe('STOP_NOT_BELOW_MARKET');
  });

  it('one position per instrument and at most 3 open positions', async () => {
    const s = setup();
    for (const [k, inst] of [['p1', 'AAA'], ['p2', 'BBB'], ['p3', 'CCC']] as const) {
      await s.gw.place(buy(k, { instrumentId: inst }));
      s.broker.fill(k, '3', '1000');
    }
    expect(await refusal(s.gw.place(buy('again', { instrumentId: 'AAA' })))).toBe('INSTRUMENT_ALREADY_OPEN');
    expect(await refusal(s.gw.place(buy('fourth', { instrumentId: 'DDD' })))).toBe('TOO_MANY_POSITIONS');
  });

  it('counts entries still working at the broker (reservations) against the exposure cap', async () => {
    const s = setup({ limits: cfg((c) => { c.capital.maxGrossExposurePct = 8; c.capital.maxPerPositionPct = 6; }) }); // 4000
    expect(await refusal(s.gw.place(buy('r1')))).toBe('ALLOWED'); // 3000 reserved, not filled
    expect(await refusal(s.gw.place(buy('r2', { instrumentId: 'BBB' })))).toBe('EXPOSURE_CAP');
  });

  it('releases a reservation once the broker says the entry was canceled', async () => {
    const s = setup({ limits: cfg((c) => { c.capital.maxGrossExposurePct = 8; c.capital.maxPerPositionPct = 6; }) });
    await s.gw.place(buy('r1'));
    await s.broker.cancel('acct', 'r1');
    expect(await refusal(s.gw.place(buy('r2', { instrumentId: 'BBB' })))).toBe('ALLOWED');
  });

  it('never spends cash it does not have (no leverage)', async () => {
    const s = setup({ broker: new FakeBroker('acct', 'USD', 2_000n) });
    expect(await refusal(s.gw.place(buy('o1')))).toBe('INSUFFICIENT_UNRESERVED_CASH');
  });

  it('refuses a foreign account and a foreign currency', async () => {
    const s = setup();
    expect(await refusal(s.gw.place(buy('o1', { accountId: 'other' })))).toBe('WRONG_ACCOUNT');
    expect(await refusal(s.gw.place(buy('o2', { currency: 'EUR' })))).toBe('CURRENCY_MISMATCH');
  });

  it('two simultaneous requests cannot both use the same exposure headroom', async () => {
    const s = setup({ limits: cfg((c) => { c.capital.maxGrossExposurePct = 8; c.capital.maxPerPositionPct = 6; }), broker: new SlowFake(60, 'acct', 'USD', 50_000n) });
    const res = await Promise.all([
      refusal(s.gw.place(buy('x1'))),
      refusal(s.gw.place(buy('x2', { instrumentId: 'BBB' }))),
    ]);
    expect(res.sort()).toEqual(['ALLOWED', 'EXPOSURE_CAP']);
    expect(s.broker.placeCalls).toBe(1);
  });

  it('a position whose price is stale makes equity unknowable, so entries stop', async () => {
    const s = setup();
    await s.gw.place(buy('h1'));
    s.broker.fill('h1', '3', '1000');
    s.price('AAA', '1000', 20_000);
    expect(await refusal(s.gw.place(buy('n1', { instrumentId: 'BBB' })))).toBe('EQUITY_UNAVAILABLE');
  });
});

describe('closing', () => {
  async function held() {
    const s = setup();
    await s.gw.place(buy('h1'));
    s.broker.fill('h1', '3', '1000');
    return s;
  }
  it('needs no stop and may be partial or total', async () => {
    const s = await held();
    expect((await s.gw.place(close('c1', 'AAA', '1'))).status).toBe('FILLED');
    expect((await s.gw.place(close('c2', 'AAA', '2'))).status).toBe('FILLED');
    expect(await s.broker.positions('acct')).toEqual([]);
  });
  it('cannot sell what is not held (no shorting)', async () => {
    const s = await held();
    expect(await refusal(s.gw.place(close('c1', 'AAA', '4')))).toBe('NO_POSITION_TO_CLOSE');
    expect(await refusal(s.gw.place(close('c2', 'BBB', '1')))).toBe('NO_POSITION_TO_CLOSE');
  });
  it('is still allowed with a stale quote and with both breakers tripped', async () => {
    const s = await held();
    s.q('AAA', '600'); // unrealised loss 1200 >= 1000: daily-loss breaker on the next entry
    expect(await refusal(s.gw.place(buy('n1', { instrumentId: 'BBB' })))).toBe('BREAKER_DAILY_LOSS');
    s.quotes.set('AAA', '600', s.clock.now - 60_000);
    expect(await refusal(s.gw.place(close('c1')))).toBe('ALLOWED');
  });
});

describe('daily loss breaker', () => {
  async function fourShares() {
    const s = setup();
    await s.gw.place(buy('h1', { quantity: '4', stopMinor: '999' })); // day starts at 50000 here; the open risk is only 4
    s.broker.fill('h1', '4', '1000'); // cash 46000
    return s;
  }
  it('trips at exactly the limit, not before', async () => {
    const s = await fourShares();
    const small = { instrumentId: 'BBB', quantity: '1', stopMinor: '999' }; // risk 1
    s.q('AAA', '752'); // equity 46000 + 3008 = 49008, loss 992, 8 left; open 4 + new 1 fits
    expect(await refusal(s.gw.place(buy('n1', small)))).toBe('ALLOWED');
    const u = await fourShares();
    u.q('AAA', '751'); // loss 996, 4 left: open risk 4 + new 1 no longer fits, the breaker has not tripped yet
    expect(await refusal(u.gw.place(buy('n1', small)))).toBe('OPEN_RISK_CAP');
    const t = await fourShares();
    t.q('AAA', '750'); // loss exactly 1000
    expect(await refusal(t.gw.place(buy('n1', small)))).toBe('BREAKER_DAILY_LOSS');
  });
  it('stays tripped after a restart even if the price recovers, and clears the next day', async () => {
    const s = await fourShares();
    s.q('AAA', '700');
    expect(await refusal(s.gw.place(buy('n1', { instrumentId: 'BBB' })))).toBe('BREAKER_DAILY_LOSS');
    s.q('AAA', '1000'); // recovered
    s.gw.close(); // the old process is gone
    const restarted = s.make(); // new process, same state file
    expect(await refusal(restarted.place(buy('n2', { instrumentId: 'BBB' })))).toBe('BREAKER_DAILY_LOSS');
    s.clock.now += DAY;
    s.q('AAA', '1000'); s.q('BBB', '1000');
    expect(await refusal(restarted.place(buy('n3', { instrumentId: 'BBB' })))).toBe('ALLOWED');
  });
  it('measures against the start of the day, which a restart does not move', async () => {
    const s = await fourShares();
    s.q('AAA', '800'); // loss 800: below the limit
    s.gw.close();
    const restarted = s.make();
    expect(await refusal(restarted.place(buy('n1', { instrumentId: 'BBB', quantity: '1', stopMinor: '999' })))).toBe('ALLOWED');
    s.q('AAA', '740'); // loss 1040 against the ORIGINAL day start
    expect(await refusal(restarted.place(buy('n2', { instrumentId: 'CCC' })))).toBe('BREAKER_DAILY_LOSS');
  });
});

describe('drawdown breaker', () => {
  const dd = (flatten = true) => cfg((c) => { c.loss.maxDrawdownPct = 2; c.loss.dailyLossLimitMicroUsd = 40_000_000; c.loss.flattenOnDrawdown = flatten; });
  /** AAA gaps through its stop and is sold at 600 (realised loss 1200); BBB is still held */
  async function gapped(flatten = true) {
    const s = setup({ limits: dd(flatten) });
    for (const [id, inst] of [['h1', 'AAA'], ['h2', 'BBB']] as const) {
      await s.gw.place(buy(id, { instrumentId: inst }));
      s.broker.fill(id, '3', '1000');
    }
    s.price('AAA', '600');
    expect(await s.broker.positions('acct')).toEqual([{ instrumentId: 'BBB', quantity: '3', costMinor: '3000' }]);
    return s;
  }
  it('blocks entries, flattens what is left once, and is sticky across days until reset', async () => {
    const s = await gapped();
    const r = (await s.gw.evaluate()) as { flattened: string[] };
    expect(r.flattened).toEqual(['gw-flatten-2026-10-27-BBB']);
    expect(await s.broker.positions('acct')).toEqual([]);
    expect(((await s.gw.evaluate()) as { flattened: string[] }).flattened).toEqual([]);
    s.clock.now += DAY;
    s.price('CCC', '1000');
    expect(await refusal(s.gw.place(buy('n1', { instrumentId: 'CCC' })))).toBe('BREAKER_DRAWDOWN');
    await s.gw.resetDrawdown('operator reviewed');
    expect(await refusal(s.gw.place(buy('n2', { instrumentId: 'CCC' })))).toBe('ALLOWED');
  });
  it('without flattenOnDrawdown it only blocks entries', async () => {
    const s = await gapped(false);
    await s.gw.evaluate();
    expect((await s.broker.positions('acct')).length).toBe(1);
    expect(await refusal(s.gw.place(buy('n1', { instrumentId: 'CCC' })))).toBe('BREAKER_DRAWDOWN');
  });
});

describe('persisted state', () => {
  it('refuses to start on a corrupt or invalid state file instead of starting empty', () => {
    const p = join(dir, 'corrupt.json');
    writeFileSync(p, '{not json');
    expect(() => setup({ path: p })).toThrow('STATE_CORRUPT');
    writeFileSync(p, JSON.stringify({ version: 1, day: 'today' }));
    expect(() => setup({ path: p })).toThrow('STATE_CORRUPT');
  });
  it('writes atomically: no temporary file is left behind', async () => {
    const s = setup();
    await s.gw.place(buy('o1'));
    expect(readdirSync(dir).filter((f) => f.startsWith(`state-`) && f.endsWith('.tmp'))).toEqual([]);
  });
});

describe('over HTTP, with the executor and PostgreSQL', () => {
  let pool: pg.Pool;
  beforeEach(async () => { pool = await resetDb(); });
  afterAll(async () => { await closePool(); });

  async function boot(broker: FakeBroker, limits = cfg()) {
    const s = setup({ broker, limits });
    const srv = createGatewayServer({ gateway: s.gw, token: 'worker-token', adminToken: 'admin-token', evaluateEveryMs: 0 });
    const port = await srv.start();
    return { ...s, srv, url: `http://127.0.0.1:${port}` };
  }
  const dbStatus = async (id: string) => (await pool.query(`select status from broker_order_intents where client_order_id=$1`, [id])).rows[0]?.status;

  it('a normal order passes; a refused one is recorded as REJECTED, not UNKNOWN, and never retried', async () => {
    const b = await boot(new FakeBroker('acct', 'USD', 50_000n));
    try {
      const worker = await GatewayBroker.connect(b.url, 'worker-token');
      const ex = new BrokerExecutor(worker, new PostgresIntentStore(pool));
      expect((await ex.submit(buy('ok'))).status).toBe('ACCEPTED');
      await expect(ex.submit(buy('risky', { instrumentId: 'BBB', stopMinor: '600' }))).rejects.toThrow('TRADE_RISK_TOO_HIGH');
      expect(await dbStatus('risky')).toBe('REJECTED');
      const calls = b.broker.placeCalls;
      expect((await ex.submit(buy('risky', { instrumentId: 'BBB', stopMinor: '600' }))).status).toBe('REJECTED');
      expect(b.broker.placeCalls).toBe(calls);
    } finally { await b.srv.stop(); }
  });

  it('a slow gateway is an UNCERTAIN outcome, then recovered by lookup without a second order', async () => {
    const b = await boot(new SlowFake(400, 'acct', 'USD', 50_000n));
    try {
      const impatient = await GatewayBroker.connect(b.url, 'worker-token', 150);
      const store = new PostgresIntentStore(pool);
      await expect(new BrokerExecutor(impatient, store).submit(buy('slow'))).rejects.toThrow('UNCERTAIN');
      expect(await dbStatus('slow')).toBe('UNKNOWN');
      await new Promise((r) => setTimeout(r, 500)); // the gateway finished the work on its own
      const patient = await GatewayBroker.connect(b.url, 'worker-token', 3_000);
      expect((await new BrokerExecutor(patient, store, { inflightGraceMs: 0 }).submit(buy('slow'))).status).toBe('ACCEPTED');
      expect(b.broker.placeCalls).toBe(1);
    } finally { await b.srv.stop(); }
  });

  it('rejects a wrong token, and the worker token cannot reach operator endpoints', async () => {
    const b = await boot(new FakeBroker('acct', 'USD', 50_000n));
    try {
      await expect(GatewayBroker.connect(b.url, 'nope')).rejects.toThrow('GATEWAY_UNAVAILABLE');
      const post = (path: string, tok: string) => fetch(`${b.url}${path}`, { method: 'POST', headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' }, body: JSON.stringify({ note: 'testing reset' }) });
      expect((await post('/admin/reset-drawdown', 'worker-token')).status).toBe(401);
      expect((await post('/admin/reset-drawdown', 'admin-token')).status).toBe(200);
    } finally { await b.srv.stop(); }
  });

  it('refuses malformed and oversized requests without reaching the broker', async () => {
    const b = await boot(new FakeBroker('acct', 'USD', 50_000n));
    try {
      const h = { authorization: 'Bearer worker-token', 'content-type': 'application/json' };
      expect((await fetch(`${b.url}/place`, { method: 'POST', headers: h, body: JSON.stringify({ intent: { kind: 'BUY_BRACKET' } }) })).status).toBe(400);
      expect((await fetch(`${b.url}/place`, { method: 'POST', headers: h, body: 'x'.repeat(70_000) })).status).toBe(413);
      expect(b.broker.placeCalls).toBe(0);
    } finally { await b.srv.stop(); }
  });
});

describe('three full positions against the exposure cap', () => {
  it('the third full-size position is refused by the 250 USD cap, a position 5 cents smaller is allowed', async () => {
    const s = setup();
    const full = (id: string, inst: string, limit: string) => buy(id, { instrumentId: inst, quantity: '5', entryLimitMinor: limit, stopMinor: '1650', targetMinor: '2200' });
    for (const i of ['AAA', 'BBB', 'CCC']) s.price(i, '2000');
    expect(await refusal(s.gw.place(full('p1', 'AAA', '1667')))).toBe('ALLOWED'); // 8335
    expect(await refusal(s.gw.place(full('p2', 'BBB', '1667')))).toBe('ALLOWED'); // 16670
    expect(await refusal(s.gw.place(full('p3', 'CCC', '1667')))).toBe('EXPOSURE_CAP'); // 25005 > 25000
    expect(await refusal(s.gw.place(full('p3b', 'CCC', '1666')))).toBe('ALLOWED'); // 25000 exactly
  });
});

describe('risk still open across trades', () => {
  const risk = (n: number, inst: string, id: string) => buy(id, { instrumentId: inst, quantity: String(n), entryLimitMinor: '1000', stopMinor: '900' }); // risk n x 100
  it('three trades that each risk 10 USD cannot all be open: the total must fit in the daily loss limit', async () => {
    const s = setup();
    expect(await refusal(s.gw.place(buy('a', { quantity: '10', entryLimitMinor: '500', stopMinor: '400', targetMinor: '700' })))).toBe('ALLOWED'); // risk 1000 = the whole daily limit
    expect(await refusal(s.gw.place(buy('b', { instrumentId: 'BBB', quantity: '1' })))).toBe('OPEN_RISK_CAP');
    expect(s.broker.placeCalls).toBe(1);
  });
  it('allows trades up to exactly the limit and refuses one cent more', async () => {
    const s = setup();
    expect(await refusal(s.gw.place(risk(4, 'AAA', 'a')))).toBe('ALLOWED'); // 400
    expect(await refusal(s.gw.place(risk(4, 'BBB', 'b')))).toBe('ALLOWED'); // 800
    expect(await refusal(s.gw.place(buy('c1', { instrumentId: 'CCC', quantity: '2', stopMinor: '899' })))).toBe('OPEN_RISK_CAP'); // 202 -> 1002
    expect(await refusal(s.gw.place(risk(2, 'CCC', 'c2')))).toBe('ALLOWED'); // exactly 1000
  });
  it('a filled position keeps its risk open, survives a restart, and is released when the position is closed', async () => {
    const s = setup();
    await s.gw.place(risk(7, 'AAA', 'a'));
    s.broker.fill('a', '7', '1000');
    expect(await refusal(s.gw.place(risk(4, 'BBB', 'b')))).toBe('OPEN_RISK_CAP'); // 700 + 400
    s.gw.close();
    const again = s.make();
    expect(await refusal(again.place(risk(4, 'BBB', 'b2')))).toBe('OPEN_RISK_CAP'); // the stop is remembered
    expect(await refusal(again.place(close('x', 'AAA', '7')))).toBe('ALLOWED');
    expect(await refusal(again.place(risk(4, 'BBB', 'b3')))).toBe('ALLOWED'); // risk released
    expect(Object.keys(again.status()!.stops)).toEqual(['BBB']); // the closed position's stop is forgotten
  });
  it('shrinks with the day: loss already taken reduces what may stay at risk', async () => {
    const s = setup();
    await s.gw.place(risk(3, 'AAA', 'a'));
    s.broker.fill('a', '3', '1000');
    s.q('AAA', '833'); // unrealised loss 3 x 167 = 501; 499 left; open risk 300
    expect(await refusal(s.gw.place(risk(2, 'BBB', 'b')))).toBe('OPEN_RISK_CAP'); // 300 + 200 = 500 > 499
    expect(await refusal(s.gw.place(buy('c', { instrumentId: 'BBB', quantity: '1' })))).toBe('ALLOWED'); // 300 + 100
  });
  it('a holding the gateway never approved counts at its full market value', async () => {
    const s = setup();
    s.broker.externalTrade('ZZZ', 'BUY', '1', '300');
    s.q('ZZZ', '300');
    expect(await refusal(s.gw.place(risk(1, 'AAA', 'a')))).toBe('ALLOWED'); // 300 + 100 fits
    expect(await refusal(s.gw.place(risk(7, 'BBB', 'b')))).toBe('OPEN_RISK_CAP'); // 300 + 100 + 700 > 1000
  });
  it('fees of the entry and the exit are part of the trade risk', async () => {
    const s = setup({ limits: cfg((c) => { c.loss.feeReserveMicroUsd = 1_000_000; }) }); // 100 cents per side
    expect(s.limits.feeReserveMinor).toBe(100n);
    const ok = { quantity: '8', entryLimitMinor: '1000', stopMinor: '900' }; // 800 + 200 = 1000
    expect(await refusal(s.gw.place(buy('a', ok)))).toBe('ALLOWED');
    expect(await refusal(s.gw.place(buy('b', { ...ok, instrumentId: 'BBB', stopMinor: '899' })))).toBe('TRADE_RISK_TOO_HIGH'); // 808 + 200
  });
  it('the example configuration reserves 1 USD per side', () => {
    expect(parseGatewayConfig(EXAMPLE).feeReserveMinor).toBe(100n);
  });
});
