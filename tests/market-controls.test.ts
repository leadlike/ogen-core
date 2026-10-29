import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
import { FakeBroker } from '../src/broker/fake';
import { OrderRefused, type BuyBracketIntent } from '../src/broker/types';
import { entryDecision, earlyCloses, easterSunday, exchangeLocal, holidays, sessionOn } from '../src/gateway/calendar';
import { parseGatewayConfig, type GatewayLimits } from '../src/gateway/config';
import { StaticQuotes } from '../src/gateway/quotes';
import { RiskGateway } from '../src/gateway/risk';
import { StateFile } from '../src/gateway/state';
import { createGatewayServer } from '../src/gateway/server';
import { GatewayBroker } from '../src/gateway/client';

const EXAMPLE = JSON.parse(readFileSync(join(__dirname, '..', 'config', 'broker-risk.example.json'), 'utf8'));
const cfg = (edit: (c: any) => void = () => undefined): GatewayLimits => { const c = structuredClone(EXAMPLE); c.loss.feeReserveMicroUsd = 0; edit(c); return parseGatewayConfig(c); };
const dir = mkdtempSync(join(tmpdir(), 'mc-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** epoch ms of a wall-clock time in New York; `offset` is the UTC offset in force that day (-4 EDT, -5 EST) */
const et = (date: string, hh: number, mm: number, offset: -4 | -5 = -4) => Date.parse(`${date}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00Z`) - offset * 3_600_000;
const W = { skipFirstMinutes: 5, skipLastMinutes: 15 };
const hol = (y: number) => [...holidays(y).keys()].sort();

describe('market calendar (rules, not a list)', () => {
  it('computes Easter for known years', () => {
    expect(easterSunday(2024)).toEqual({ y: 2024, m: 3, d: 31 });
    expect(easterSunday(2025)).toEqual({ y: 2025, m: 4, d: 20 });
    expect(easterSunday(2026)).toEqual({ y: 2026, m: 4, d: 5 });
    expect(easterSunday(2027)).toEqual({ y: 2027, m: 3, d: 28 });
    expect(easterSunday(2030)).toEqual({ y: 2030, m: 4, d: 21 });
  });
  it('matches the published NYSE full-day closures for 2024', () => {
    expect(hol(2024)).toEqual(['2024-01-01', '2024-01-15', '2024-02-19', '2024-03-29', '2024-05-27', '2024-06-19', '2024-07-04', '2024-09-02', '2024-11-28', '2024-12-25']);
    expect([...earlyCloses(2024)].sort()).toEqual(['2024-07-03', '2024-11-29', '2024-12-24']);
  });
  it('matches 2025 (the one-off Jan 9 closure is NOT derivable and needs the config)', () => {
    expect(hol(2025)).toEqual(['2025-01-01', '2025-01-20', '2025-02-17', '2025-04-18', '2025-05-26', '2025-06-19', '2025-07-04', '2025-09-01', '2025-11-27', '2025-12-25']);
    expect([...earlyCloses(2025)].sort()).toEqual(['2025-07-03', '2025-11-28', '2025-12-24']);
    expect('session' in sessionOn('2025-01-09')).toBe(true);
    expect(sessionOn('2025-01-09', { extraClosedDates: new Set(['2025-01-09']) })).toEqual({ closed: 'SPECIAL_CLOSURE' });
  });
  it('matches 2026, including July 4 on a Saturday (closed Friday Jul 3, no early close Jul 2)', () => {
    expect(hol(2026)).toEqual(['2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03', '2026-05-25', '2026-06-19', '2026-07-03', '2026-09-07', '2026-11-26', '2026-12-25']);
    expect([...earlyCloses(2026)].sort()).toEqual(['2026-11-27', '2026-12-24']);
  });
  it('matches 2027: Juneteenth and Christmas observed on Friday, July 4 on Monday, Dec 31 open', () => {
    expect(hol(2027)).toEqual(['2027-01-01', '2027-01-18', '2027-02-15', '2027-03-26', '2027-05-31', '2027-06-18', '2027-07-05', '2027-09-06', '2027-11-25', '2027-12-24']);
    expect('session' in sessionOn('2027-12-31')).toBe(true); // Jan 1 2028 is a Saturday: not observed on Friday
    expect([...earlyCloses(2027)]).toEqual(['2027-11-26']);
  });
  it('is not limited to 2026: works far in the future', () => {
    expect(holidays(2040).get('2040-03-30')).toBe('Good Friday'); // Easter 2040 is April 1
    expect(sessionOn('2040-07-04')).toEqual({ closed: 'HOLIDAY:Independence Day' });
  });
  it('weekends are closed and ordinary days have a 09:30-16:00 session', () => {
    expect(sessionOn('2026-10-31')).toEqual({ closed: 'WEEKEND' });
    expect(sessionOn('2026-11-01')).toEqual({ closed: 'WEEKEND' });
    expect(sessionOn('2026-10-27')).toEqual({ session: { date: '2026-10-27', openMin: 570, closeMin: 960, early: false } });
    expect(sessionOn('2026-11-27')).toEqual({ session: { date: '2026-11-27', openMin: 570, closeMin: 780, early: true } });
  });
  it('config can add an early close', () => {
    const r = sessionOn('2026-10-28', { extraEarlyCloseDates: new Set(['2026-10-28']) });
    expect(r).toMatchObject({ session: { closeMin: 780, early: true } });
  });
  it('reads the New York wall clock across daylight saving time', () => {
    expect(exchangeLocal(Date.UTC(2026, 9, 27, 15, 0))).toEqual({ date: '2026-10-27', minutes: 11 * 60 });   // EDT
    expect(exchangeLocal(Date.UTC(2026, 10, 3, 16, 0))).toEqual({ date: '2026-11-03', minutes: 11 * 60 });   // EST, after Nov 1
    expect(exchangeLocal(Date.UTC(2026, 2, 9, 14, 0))).toEqual({ date: '2026-03-09', minutes: 10 * 60 });    // EDT, after Mar 8
    expect(exchangeLocal(Date.UTC(2026, 9, 28, 3, 59))).toEqual({ date: '2026-10-27', minutes: 23 * 60 + 59 }); // still yesterday in NY
  });
  it('entry window: first/last minutes are skipped, boundaries are exact', () => {
    const d = '2026-10-27';
    expect(entryDecision(et(d, 9, 29), W)).toMatchObject({ allowed: false, code: 'MARKET_CLOSED' });
    expect(entryDecision(et(d, 9, 30), W)).toMatchObject({ allowed: false, code: 'OUTSIDE_ENTRY_WINDOW' });
    expect(entryDecision(et(d, 9, 34), W)).toMatchObject({ allowed: false, code: 'OUTSIDE_ENTRY_WINDOW' });
    expect(entryDecision(et(d, 9, 35), W).allowed).toBe(true);
    expect(entryDecision(et(d, 15, 44), W).allowed).toBe(true);
    expect(entryDecision(et(d, 15, 45), W)).toMatchObject({ allowed: false, code: 'OUTSIDE_ENTRY_WINDOW' });
    expect(entryDecision(et(d, 16, 0), W)).toMatchObject({ allowed: false, code: 'MARKET_CLOSED' });
  });
  it('early close day: entries stop at 12:45', () => {
    const d = '2026-11-27';
    expect(entryDecision(et(d, 12, 44, -5), W).allowed).toBe(true);
    expect(entryDecision(et(d, 12, 45, -5), W)).toMatchObject({ allowed: false, code: 'OUTSIDE_ENTRY_WINDOW' });
    expect(entryDecision(et(d, 13, 30, -5), W)).toMatchObject({ allowed: false, code: 'MARKET_CLOSED' });
  });
  it('holiday and weekend are closed at any hour; the same hour on a normal day is open', () => {
    expect(entryDecision(et('2026-11-26', 11, 0, -5), W)).toMatchObject({ allowed: false, code: 'MARKET_CLOSED', detail: expect.stringContaining('Thanksgiving') });
    expect(entryDecision(et('2026-10-31', 11, 0), W)).toMatchObject({ allowed: false, code: 'MARKET_CLOSED' });
    expect(entryDecision(et('2026-11-03', 11, 0, -5), W).allowed).toBe(true);
  });
  it('the timestamp of a US evening that is already tomorrow in UTC is judged in New York', () => {
    // Mon 2026-10-26 22:00 EDT = Tue 02:00 UTC: UTC says Tuesday morning, New York says Monday night
    expect(entryDecision(Date.UTC(2026, 9, 27, 2, 0), W)).toMatchObject({ allowed: false, code: 'MARKET_CLOSED' });
  });
});

describe('configuration of the new controls', () => {
  it('has the agreed defaults and a position cap of 16.67%', () => {
    const l = cfg();
    expect(l.perPositionMinor).toBe(8_335n);
    expect(l.maxSpreadBps).toBe(50n);
    expect(l.allowedSymbols.has('SCHD')).toBe(true);
    expect(l.entryWindow.skipFirstMinutes).toBe(5);
  });
  it('rejects a bad symbol, an empty allowlist, a bad date, a non-NYSE timezone and an absurd window', () => {
    expect(() => cfg((c) => { c.instruments.allowedSymbols = ['spy']; })).toThrow();
    expect(() => cfg((c) => { c.instruments.allowedSymbols = []; })).toThrow();
    expect(() => cfg((c) => { c.session.extraClosedDates = ['2026-02-30']; })).toThrow();
    expect(() => cfg((c) => { c.session.timezone = 'Europe/Paris'; })).toThrow(/America\/New_York/);
    expect(() => cfg((c) => { c.session.entryWindow = { skipFirstMinutes: 200, skipLastMinutes: 150 }; })).toThrow(/less than an hour/);
    expect(() => cfg((c) => { c.quotes.maxSpreadBps = 0; })).toThrow();
    expect(() => { const c = structuredClone(EXAMPLE); delete c.instruments; parseGatewayConfig(c); }).toThrow();
    expect(() => { const c = structuredClone(EXAMPLE); delete c.quotes.maxSpreadBps; parseGatewayConfig(c); }).toThrow();
  });
});

const T0 = Date.UTC(2026, 9, 27, 15, 0, 0); // Tue 11:00 EDT
const buy = (id: string, over: Partial<BuyBracketIntent> = {}): BuyBracketIntent => ({
  kind: 'BUY_BRACKET', mode: 'BROKER_PAPER', accountId: 'acct', clientOrderId: id, instrumentId: 'AAA', currency: 'USD',
  quantity: '3', entryLimitMinor: '1000', stopMinor: '900', targetMinor: '1250', ...over,
});
let n = 0;
function setup(limits = cfg()) {
  const broker = new FakeBroker('acct', 'USD', 50_000n);
  const quotes = new StaticQuotes();
  const clock = { now: T0 };
  const path = join(dir, `state-${++n}.json`);
  const gw = new RiskGateway({ broker, quotes, limits, accountId: 'acct', stateFile: new StateFile(path), now: () => clock.now });
  for (const s of ['AAA', 'BBB', 'ZZZ']) { quotes.set(s, '1000', clock.now); broker.tick(s, '1000'); }
  return { broker, quotes, clock, gw, path };
}
const refusal = async (p: Promise<unknown>) => { try { await p; } catch (e) { if (e instanceof OrderRefused) return e.code; throw e; } return 'ALLOWED'; };

describe('bid/ask spread filter', () => {
  it('allows a tight book and refuses one wider than the limit, at the exact boundary', async () => {
    const s = setup();
    // mid 1000: 50 bps = 5.00 wide. bid 998 / ask 1003 -> 5 cents of 1000.5 mid = 49.97 bps -> allowed
    s.quotes.set('AAA', '1000', T0, { bid: '998', ask: '1003' });
    expect(await refusal(s.gw.place(buy('a')))).toBe('ALLOWED');
    // bid 997 / ask 1003 -> 6/1000 = 60 bps -> refused
    s.quotes.set('BBB', '1000', T0, { bid: '997', ask: '1003' });
    expect(await refusal(s.gw.place(buy('b', { instrumentId: 'BBB' })))).toBe('SPREAD_TOO_WIDE');
    expect(s.broker.placeCalls).toBe(1);
  });
  it('is exact: bid 399 / ask 401 is exactly 50 bps and passes; ask 402 fails (integer check, no rounding)', async () => {
    const s = setup();
    const small = { quantity: '3', entryLimitMinor: '400', stopMinor: '380', targetMinor: '450' };
    s.quotes.set('AAA', '400', T0, { bid: '399', ask: '401' });
    expect(await refusal(s.gw.place(buy('x', small)))).toBe('ALLOWED');
    s.quotes.set('BBB', '400', T0, { bid: '399', ask: '402' });
    expect(await refusal(s.gw.place(buy('y', { ...small, instrumentId: 'BBB' })))).toBe('SPREAD_TOO_WIDE');
  });
  it('refuses a quote with no bid/ask, a crossed book, and a zero bid', async () => {
    const s = setup();
    s.quotes.set('AAA', '1000', T0, {});
    expect(await refusal(s.gw.place(buy('a')))).toBe('NO_BID_ASK');
    s.quotes.set('AAA', '1000', T0, { bid: '1002', ask: '1000' });
    expect(await refusal(s.gw.place(buy('b')))).toBe('INVALID_QUOTE');
    s.quotes.set('AAA', '1000', T0, { bid: '0', ask: '1000' });
    expect(await refusal(s.gw.place(buy('c')))).toBe('INVALID_QUOTE');
    expect(s.broker.placeCalls).toBe(0);
  });
  it('refuses a stop at or above the bid even when it is below the last price', async () => {
    const s = setup();
    s.quotes.set('AAA', '1000', T0, { bid: '996', ask: '1000' });
    expect(await refusal(s.gw.place(buy('a', { stopMinor: '996' })))).toBe('STOP_NOT_BELOW_MARKET');
    expect(await refusal(s.gw.place(buy('b', { stopMinor: '995' })))).toBe('ALLOWED');
  });
  it('never blocks a CLOSE, even on a terrible book', async () => {
    const s = setup();
    await s.gw.place(buy('a'));
    s.broker.fill('a', '3', '1000');
    s.quotes.set('AAA', '1000', T0, { bid: '500', ask: '1500' });
    expect(await refusal(s.gw.place({ kind: 'CLOSE', mode: 'BROKER_PAPER', accountId: 'acct', clientOrderId: 'c', instrumentId: 'AAA', currency: 'USD', quantity: '3' }))).toBe('ALLOWED');
  });
});

describe('symbol allowlist at the gateway', () => {
  it('refuses a symbol that is not listed, before any quote lookup, and sends nothing', async () => {
    const s = setup();
    expect(await refusal(s.gw.place(buy('z', { instrumentId: 'ZZZ' })))).toBe('SYMBOL_NOT_ALLOWED');
    expect(await refusal(s.gw.place(buy('lower', { instrumentId: 'aaa' })))).toBe('SYMBOL_NOT_ALLOWED');
    expect(s.broker.placeCalls).toBe(0);
    expect(readFileSync(`${s.path}.audit.jsonl`, 'utf8')).toContain('SYMBOL_NOT_ALLOWED');
  });
  it('a worker that asks for an unlisted symbol over HTTP gets a definite refusal (422)', async () => {
    const s = setup();
    const srv = createGatewayServer({ gateway: s.gw, token: 'w', evaluateEveryMs: 0 });
    const url = `http://127.0.0.1:${await srv.start()}`;
    try {
      const worker = await GatewayBroker.connect(url, 'w');
      await expect(worker.place(buy('z', { instrumentId: 'ZZZ' }))).rejects.toMatchObject({ code: 'SYMBOL_NOT_ALLOWED' });
      expect((await worker.place(buy('ok'))).status).toBe('ACCEPTED');
    } finally { await srv.stop(); }
  });
  it('CLOSE of a held symbol that later left the allowlist is still allowed', async () => {
    const s = setup();
    await s.gw.place(buy('a'));
    s.broker.fill('a', '3', '1000');
    const narrower = cfg((c) => { c.instruments.allowedSymbols = ['SPY']; });
    s.gw.close();
    const gw2 = new RiskGateway({ broker: s.broker, quotes: s.quotes, limits: narrower, accountId: 'acct', stateFile: new StateFile(s.path), now: () => s.clock.now });
    expect(await refusal(gw2.place({ kind: 'CLOSE', mode: 'BROKER_PAPER', accountId: 'acct', clientOrderId: 'c', instrumentId: 'AAA', currency: 'USD', quantity: '3' }))).toBe('ALLOWED');
    gw2.close();
  });
});

describe('market calendar in the gateway', () => {
  it('refuses entries on a weekend, a holiday, before the open, after the close, and in the skipped minutes', async () => {
    const s = setup();
    const at = async (ms: number, id: string) => { s.clock.now = ms; for (const x of ['AAA']) s.quotes.set(x, '1000', ms); return refusal(s.gw.place(buy(id))); };
    expect(await at(et('2026-10-31', 11, 0), 'sat')).toBe('MARKET_CLOSED');
    expect(await at(et('2026-11-26', 11, 0, -5), 'thanks')).toBe('MARKET_CLOSED');
    expect(await at(et('2026-10-27', 9, 0), 'pre')).toBe('MARKET_CLOSED');
    expect(await at(et('2026-10-27', 16, 30), 'post')).toBe('MARKET_CLOSED');
    expect(await at(et('2026-10-27', 9, 31), 'open')).toBe('OUTSIDE_ENTRY_WINDOW');
    expect(await at(et('2026-10-27', 15, 50), 'close')).toBe('OUTSIDE_ENTRY_WINDOW');
    expect(s.broker.placeCalls).toBe(0);
    expect(await at(et('2026-10-27', 11, 0), 'mid')).toBe('ALLOWED');
  });
  it('config can close an extra day the rules do not know about', async () => {
    const s = setup(cfg((c) => { c.session.extraClosedDates = ['2026-10-27']; }));
    expect(await refusal(s.gw.place(buy('a')))).toBe('MARKET_CLOSED');
  });
  it('the calendar is checked before the quote, so a closed market is reported as such', async () => {
    const s = setup();
    s.clock.now = et('2026-10-31', 11, 0);
    s.quotes.clear('AAA');
    expect(await refusal(s.gw.place(buy('a')))).toBe('MARKET_CLOSED');
  });
  it('never blocks a CLOSE or a flatten on a closed day', async () => {
    const s = setup();
    await s.gw.place(buy('a'));
    s.broker.fill('a', '3', '1000');
    s.clock.now = et('2026-10-31', 11, 0);
    expect(await refusal(s.gw.place({ kind: 'CLOSE', mode: 'BROKER_PAPER', accountId: 'acct', clientOrderId: 'c', instrumentId: 'AAA', currency: 'USD', quantity: '3' }))).toBe('ALLOWED');
  });
});

describe('single-instance lock', () => {
  const mk = (name: string) => join(dir, name);
  it('a second gateway on the same state file refuses to start, and the first keeps working', async () => {
    const s = setup();
    const other = () => new RiskGateway({ broker: s.broker, quotes: s.quotes, limits: cfg(), accountId: 'acct', stateFile: new StateFile(s.path), now: () => s.clock.now });
    expect(other).toThrow(/LOCKED/);
    expect(await refusal(s.gw.place(buy('a')))).toBe('ALLOWED');
  });
  it('close() releases it, so a restart works, and a second close is harmless', () => {
    const s = setup();
    s.gw.close(); s.gw.close();
    expect(existsSync(`${s.path}.lock`)).toBe(false);
    const g2 = new RiskGateway({ broker: s.broker, quotes: s.quotes, limits: cfg(), accountId: 'acct', stateFile: new StateFile(s.path) });
    expect(existsSync(`${s.path}.lock`)).toBe(true);
    g2.close();
  });
  it('a gateway that fails to load its state does not keep the lock', () => {
    const p = mk('corrupt.json');
    writeFileSync(p, '{not json');
    const b = new FakeBroker('acct', 'USD', 50_000n);
    expect(() => new RiskGateway({ broker: b, quotes: new StaticQuotes(), limits: cfg(), accountId: 'acct', stateFile: new StateFile(p) })).toThrow(/STATE_CORRUPT/);
    expect(existsSync(`${p}.lock`)).toBe(false);
  });
  it('takes over a lock left by a dead process on this host', () => {
    const p = mk('stale.json');
    writeFileSync(`${p}.lock`, JSON.stringify({ pid: 2_147_483_000, host: hostname(), startedAt: 'x', token: 'old' }));
    const f = new StateFile(p);
    f.acquire();
    expect(JSON.parse(readFileSync(`${p}.lock`, 'utf8')).pid).toBe(process.pid);
    f.release();
  });
  it('refuses a lock held by a live process, by another host, or in an unknown format', () => {
    const p = mk('held.json');
    const put = (o: unknown) => writeFileSync(`${p}.lock`, typeof o === 'string' ? o : JSON.stringify(o));
    put({ pid: process.pid, host: hostname(), token: 't' });
    expect(() => new StateFile(p).acquire()).toThrow(/another gateway/);
    put({ pid: 2_147_483_000, host: 'some-other-host', token: 't' });
    expect(() => new StateFile(p).acquire()).toThrow(/other-host/);
    put('garbage');
    expect(() => new StateFile(p).acquire()).toThrow(/unreadable/);
    put({ nope: 1 });
    expect(() => new StateFile(p).acquire()).toThrow(/unknown format/);
    rmSync(`${p}.lock`);
  });
  it('release() never removes a lock that someone else now owns', () => {
    const p = mk('stolen.json');
    const f = new StateFile(p);
    f.acquire();
    writeFileSync(`${p}.lock`, JSON.stringify({ pid: 1, host: 'elsewhere', token: 'other' }));
    f.release();
    expect(existsSync(`${p}.lock`)).toBe(true);
    rmSync(`${p}.lock`);
  });

  // real processes: the lock must hold across process boundaries, and die with the process
  const child = (p: string, mode: 'hold' | 'try') => spawn(process.execPath, ['--import', 'tsx', '-e', `
    const { StateFile } = require(${JSON.stringify(join(__dirname, '..', 'src', 'gateway', 'state.ts'))});
    const f = new StateFile(${JSON.stringify(p)});
    try { f.acquire(); } catch (e) { console.log('REFUSED ' + e.message); process.exit(3); }
    console.log('ACQUIRED');
    ${mode === 'hold' ? 'setInterval(() => {}, 1000);' : 'process.exit(0);'}
  `], { stdio: ['ignore', 'pipe', 'pipe'] });
  const waitFor = (c: ReturnType<typeof child>, re: RegExp) => new Promise<string>((res, rej) => {
    let out = '';
    const t = setTimeout(() => rej(new Error(`timeout; saw: ${out}`)), 15_000);
    c.stdout!.on('data', (d) => { out += d; if (re.test(out)) { clearTimeout(t); res(out); } });
    c.stderr!.on('data', (d) => { out += d; });
    c.on('exit', () => { clearTimeout(t); if (!re.test(out)) rej(new Error(`exited; saw: ${out}`)); });
  });

  it('two real processes: the second is refused while the first lives; after the first is killed, a third starts', async () => {
    const p = mk('procs.json');
    const a = child(p, 'hold');
    try {
      await waitFor(a, /ACQUIRED/);
      const b = child(p, 'try');
      const out = await waitFor(b, /REFUSED LOCKED/);
      expect(out).toMatch(/another gateway/);
      a.kill('SIGKILL'); // no cleanup runs: the lock file is left behind
      await new Promise((r) => a.once('exit', r));
      expect(existsSync(`${p}.lock`)).toBe(true);
      const c = child(p, 'try');
      await waitFor(c, /ACQUIRED/); // stale lock of a dead pid is taken over
    } finally { a.kill('SIGKILL'); }
  }, 40_000);

  it('a normally exiting process removes its own lock', async () => {
    const p = mk('exit.json');
    const c = child(p, 'try');
    await waitFor(c, /ACQUIRED/);
    await new Promise((r) => c.once('exit', r));
    expect(existsSync(`${p}.lock`)).toBe(false);
  }, 20_000);
});

describe('single-instance lock on a shared volume (heartbeat)', () => {
  const p = (n: string) => join(dir, n);
  const foreign = (path: string, ageMs: number) => writeFileSync(`${path}.lock`, JSON.stringify({ pid: 1, host: 'old-task-host', startedAt: 'x', heartbeatAt: Date.now() - ageMs, token: 'old' }));
  it('without the option, a lock from another host is never taken over, however old', () => {
    const path = p('hb1.json'); foreign(path, 3_600_000);
    expect(() => new StateFile(path).acquire()).toThrow(/old-task-host/);
  });
  it('with the option, a lock from another host with a fresh heartbeat is still refused', () => {
    const path = p('hb2.json'); foreign(path, 5_000);
    expect(() => new StateFile(path, { staleAfterMs: 30_000 }).acquire()).toThrow(/old-task-host/);
  });
  it('with the option, a lock from another host whose heartbeat stopped is taken over', () => {
    const path = p('hb3.json'); foreign(path, 120_000);
    const f = new StateFile(path, { staleAfterMs: 30_000 });
    f.acquire();
    expect(JSON.parse(readFileSync(`${path}.lock`, 'utf8')).host).toBe(hostname());
    f.release();
  });
  it('a lock from another host with no heartbeat at all (older format) is never taken over', () => {
    const path = p('hb4.json');
    writeFileSync(`${path}.lock`, JSON.stringify({ pid: 1, host: 'old-task-host', token: 'old' }));
    expect(() => new StateFile(path, { staleAfterMs: 30_000 }).acquire()).toThrow(/old-task-host/);
  });
  it('the owner keeps its heartbeat fresh, so a contender never sees it as stale', async () => {
    const path = p('hb5.json');
    const f = new StateFile(path, { staleAfterMs: 400, heartbeatMs: 50 });
    f.acquire();
    await new Promise((r) => setTimeout(r, 700));
    const hb = JSON.parse(readFileSync(`${path}.lock`, 'utf8')).heartbeatAt as number;
    expect(Date.now() - hb).toBeLessThan(300);
    f.release();
  });
  it('an owner that finds its lock taken stops being the instance: it is told, and the gateway refuses new entries', async () => {
    const path = p('hb6.json');
    const broker = new FakeBroker('acct', 'USD', 50_000n);
    const quotes = new StaticQuotes();
    for (const s of ['AAA']) { quotes.set(s, '1000', T0); broker.tick(s, '1000'); }
    const sf = new StateFile(path, { staleAfterMs: 400, heartbeatMs: 50 });
    const gw = new RiskGateway({ broker, quotes, limits: cfg(), accountId: 'acct', stateFile: sf, now: () => T0 });
    expect(await refusal(gw.place(buy('a')))).toBe('ALLOWED');
    writeFileSync(`${path}.lock`, JSON.stringify({ pid: 9, host: 'new-task', heartbeatAt: Date.now(), token: 'usurper' })); // another instance took over
    await new Promise((r) => setTimeout(r, 200));
    quotes.set('BBB', '1000', T0); broker.tick('BBB', '1000');
    expect(await refusal(gw.place(buy('b', { instrumentId: 'BBB' })))).toBe('GATEWAY_FENCED');
    expect(readFileSync(`${path}.audit.jsonl`, 'utf8')).toContain('FENCED');
    expect(JSON.parse(readFileSync(`${path}.lock`, 'utf8')).token).toBe('usurper'); // we did not delete theirs
    rmSync(`${path}.lock`);
  });
  it('a frozen instance woken after the takeover, BEFORE its heartbeat ran, still cannot send an order or write the state', async () => {
    const path = p('hb7.json');
    const broker = new FakeBroker('acct', 'USD', 50_000n);
    const quotes = new StaticQuotes();
    for (const s of ['AAA', 'BBB']) { quotes.set(s, '1000', T0); broker.tick(s, '1000'); }
    const sf = new StateFile(path, { staleAfterMs: 60_000, heartbeatMs: 3_600_000 }); // heartbeat effectively never fires: the frozen case
    const gw = new RiskGateway({ broker, quotes, limits: cfg(), accountId: 'acct', stateFile: sf, now: () => T0 });
    expect(await refusal(gw.place(buy('a')))).toBe('ALLOWED');
    writeFileSync(`${path}.lock`, JSON.stringify({ pid: 9, host: 'new-task', heartbeatAt: Date.now(), token: 'usurper' }));
    const before = readFileSync(path, 'utf8');
    expect(await refusal(gw.place(buy('b', { instrumentId: 'BBB' })))).toBe('GATEWAY_FENCED');
    expect(readFileSync(path, 'utf8')).toBe(before); // the new owner's state was not overwritten
    expect(await broker.getOrder('acct', 'b')).toBeNull(); // nothing reached the broker
    rmSync(`${path}.lock`);
  });
});
