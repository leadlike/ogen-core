/**
 * End-to-end check against a REAL IB Gateway logged in to a PAPER account. Run it yourself:
 *
 *   IB_ACCOUNT=DU1234567 IB_PORT=4004 BROKER_RISK_CONFIG=config/broker-risk.json \
 *   VERIFY_SYMBOL=SCHD VERIFY_CONFIRM=PLACE_PAPER_ORDERS \
 *   [VERIFY_DATABASE_URL=postgres://...  (a scratch database, migrations applied)] \
 *   npm run verify:ibkr
 *
 * It uses the same RiskGateway, IbkrBroker and IbkrQuotes as the daemon, with a throw-away state file, and walks:
 *   connect -> account -> real-time bid/ask -> 1-share bracket -> fill -> protection confirmed at IB
 *   -> lose and regain the connection -> close -> executions + real commissions -> reconciliation.
 * It places REAL ORDERS in the paper account (1 share). It refuses to start without VERIFY_CONFIRM, and refuses a
 * non-paper account or port. It must be run during regular US market hours: the gateway's own calendar refuses entries otherwise.
 *
 * Every step is printed as PASS / FAIL / SKIP and the observations are written to verify-ibkr-report-<time>.json,
 * with secrets and the account number masked, so the report can be shared as is.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { IbkrBroker } from '../src/broker/ibkr/broker';
import { StoqeyClient } from '../src/broker/ibkr/client';
import { IbkrQuotes } from '../src/broker/ibkr/quotes';
import { BrokerBooks, Reconciler } from '../src/broker/reconcile';
import { OrderRefused, type BrokerOrder } from '../src/broker/types';
import { readSettings } from '../src/gateway/daemon';
import { RiskGateway } from '../src/gateway/risk';
import { StateFile } from '../src/gateway/state';

type Status = 'PASS' | 'FAIL' | 'SKIP';
const steps: Array<{ step: string; status: Status; detail: unknown }> = [];
const mask = (a: string) => `${a.slice(0, 2)}…${a.slice(-3)}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const cents = (m: string | bigint) => `${(Number(m) / 100).toFixed(2)} USD`;

function record(step: string, status: Status, detail: unknown = ''): void {
  steps.push({ step, status, detail });
  console.log(`${status.padEnd(5)} ${step}${detail ? '  ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : ''}`);
}
class StopHere extends Error {}
function must(ok: boolean, step: string, detail: unknown = ''): void {
  record(step, ok ? 'PASS' : 'FAIL', detail);
  if (!ok) throw new StopHere(step);
}

async function poll<T>(fn: () => Promise<T>, done: (v: T) => boolean, ms: number, every = 1_000): Promise<T> {
  const t0 = Date.now();
  let v = await fn();
  while (!done(v) && Date.now() - t0 < ms) { await sleep(every); v = await fn(); }
  return v;
}

async function main(): Promise<void> {
  if (process.env.VERIFY_CONFIRM !== 'PLACE_PAPER_ORDERS') throw new Error('Set VERIFY_CONFIRM=PLACE_PAPER_ORDERS: this script places real orders (1 share) in the PAPER account.');
  const symbol = process.env.VERIFY_SYMBOL;
  if (!symbol) throw new Error('Set VERIFY_SYMBOL to a liquid symbol from your allowlist whose price is below the per-position cap (whole shares only).');
  const env = { GATEWAY_TOKEN: 'x'.repeat(32), GATEWAY_ADMIN_TOKEN: 'y'.repeat(32), GATEWAY_STATE_FILE: 'unused', ...process.env } as NodeJS.ProcessEnv;
  const s = readSettings(env); // same guards as the daemon: DU account, paper port, valid risk config
  if (!s.limits.allowedSymbols.has(symbol)) throw new Error(`${symbol} is not in instruments.allowedSymbols of the risk config`);

  const tmp = mkdtempSync(join(tmpdir(), 'verify-ibkr-'));
  let client = new StoqeyClient(s.ibHost, s.ibPort, s.ibClientId + 1); // a different client id than the daemon's
  let broker = new IbkrBroker(client, { accountId: s.account });
  let quotes: IbkrQuotes | null = null;
  let gateway: RiskGateway | null = null;
  let pool: pg.Pool | null = null;
  const stamp = Date.now();
  const entryId = `verify-${stamp}`, closeId = `verify-close-${stamp}`;
  const observed: Record<string, unknown> = { account: mask(s.account), port: s.ibPort, symbol };

  try {
    // 1. connection and account
    await broker.connect();
    record('connect to IB Gateway and find the paper account in the session', 'PASS', mask(s.account));
    const acct = await broker.account(s.account);
    must(BigInt(acct.cashMinor) > 0n, 'read cash balance in USD', cents(acct.cashMinor));
    const startCash = BigInt(acct.cashMinor);
    observed.startCash = acct.cashMinor;
    const before = await broker.positions(s.account);
    must(before.length === 0, 'account holds no positions (a clean slate for the check)', before.length ? before : 'none');
    await broker.refreshAll();
    must(broker.describeOrders().filter((o) => ['PreSubmitted', 'Submitted'].includes(o.status)).length === 0, 'no working orders are open', 'none');

    // 2. real-time bid/ask
    quotes = new IbkrQuotes(client, s.limits.allowedSymbols, { firstTickWaitMs: 20_000 });
    quotes.start();
    const q = await quotes.quote(symbol);
    must(!!q?.bidMinor && !!q.askMinor, 'real-time bid/ask received (not delayed)', q ? { bid: cents(q.bidMinor!), ask: cents(q.askMinor!), ageMs: Date.now() - q.asOfMs } : 'no quote: no real-time subscription, or the market is closed');
    const bid = BigInt(q!.bidMinor!), ask = BigInt(q!.askMinor!);
    observed.quote = { bid: bid.toString(), ask: ask.toString() };
    must(ask * 100n <= s.limits.perPositionMinor * 100n, 'one share fits under the per-position cap', `${cents(ask)} <= ${cents(s.limits.perPositionMinor)}`);

    // 3. the entry, through the real risk gateway
    gateway = new RiskGateway({ broker, quotes, limits: s.limits, accountId: s.account, stateFile: new StateFile(join(tmp, 'state.json')) });
    const limit = ask + (ask / 1000n > 1n ? ask / 1000n : 1n); // 0.1% above the ask: marketable, bounded
    const stop = bid - (bid * 15n) / 1000n; // 1.5% under the bid
    const target = ask + (ask * 30n) / 1000n;
    let placed: BrokerOrder;
    try {
      placed = await gateway.place({ kind: 'BUY_BRACKET', mode: 'BROKER_PAPER', accountId: s.account, clientOrderId: entryId, instrumentId: symbol, currency: 'USD', quantity: '1', entryLimitMinor: limit.toString(), stopMinor: stop.toString(), targetMinor: target.toString() });
    } catch (e) {
      if (e instanceof OrderRefused) { record('the risk gateway accepts a 1-share bracket', 'FAIL', `refused ${e.code} ${e.message}`); throw new StopHere('refused'); }
      throw e;
    }
    record('1-share bracket accepted by IB', 'PASS', { limit: cents(limit), stop: cents(stop), target: cents(target), status: placed.status });
    observed.entry = placed;

    // 4. fill and protection
    const filled = await poll(() => gateway!.getOrder(s.account, entryId), (o) => o?.status === 'FILLED', 90_000);
    must(filled?.status === 'FILLED', 'entry filled within 90 s', filled ? { status: filled.status, avg: filled.averageFillMinor } : 'not visible');
    must(filled!.protectedQuantity === '1', 'stop is live at IB for the filled share', filled);
    const live = broker.describeOrders().filter((o) => o.symbol === symbol && ['PreSubmitted', 'Submitted'].includes(o.status));
    must(live.length === 2 && live.every((o) => o.action === 'SELL' && o.oca === entryId), 'stop and target are live at IB as one OCA group', live);
    observed.filled = filled;

    // 5. lose and regain the connection: protection must live at IB, and the order must be found again by its reference
    broker.disconnect();
    quotes.stop();
    await sleep(3_000);
    client = new StoqeyClient(s.ibHost, s.ibPort, s.ibClientId + 1);
    broker = new IbkrBroker(client, { accountId: s.account });
    await broker.connect();
    const again = await broker.getOrder(s.account, entryId);
    must(again?.status === 'FILLED' && again.protectedQuantity === '1', 'after reconnecting, the same order is found by its orderRef and is still protected', again);

    // 6. close, through a fresh gateway on the reconnected adapter
    quotes = new IbkrQuotes(client, s.limits.allowedSymbols, { firstTickWaitMs: 20_000 });
    quotes.start();
    await quotes.quote(symbol);
    gateway.close();
    gateway = new RiskGateway({ broker, quotes, limits: s.limits, accountId: s.account, stateFile: new StateFile(join(tmp, 'state.json')) });
    await gateway.place({ kind: 'CLOSE', mode: 'BROKER_PAPER', accountId: s.account, clientOrderId: closeId, instrumentId: symbol, currency: 'USD', quantity: '1' });
    const closed = await poll(() => gateway!.getOrder(s.account, closeId), (o) => o?.status === 'FILLED', 90_000);
    must(closed?.status === 'FILLED', 'close (market sell, inside the OCA group) filled', closed);
    const bracket = await gateway.getOrder(s.account, entryId);
    must(bracket?.exitReason === 'CLOSE' && bracket.exitedQuantity === '1' && bracket.protectedQuantity === '0', 'the bracket reports the close as its exit', bracket);
    await broker.refreshAll();
    const leftovers = broker.describeOrders().filter((o) => o.symbol === symbol && ['PreSubmitted', 'Submitted'].includes(o.status));
    must(leftovers.length === 0, 'no stop or target is left working after the close', leftovers.length ? leftovers : 'none');
    must((await broker.positions(s.account)).length === 0, 'the account is flat again');

    // 7. executions and commissions
    await sleep(3_000);
    const ex = await broker.executions(s.account, stamp - 60_000);
    must(ex.length >= 2 && ex.every((e) => /^\d+$/.test(e.feeMinor)), 'executions carry real commissions', ex.map((e) => ({ side: e.side, price: cents(e.priceMinor), fee: cents(e.feeMinor), clientOrderId: e.clientOrderId })));
    observed.executions = ex;

    // 8. reconciliation against the books (needs a scratch database)
    if (!process.env.VERIFY_DATABASE_URL) {
      record('reconciliation of books against IB', 'SKIP', 'set VERIFY_DATABASE_URL to a scratch database with the migrations applied');
    } else {
      pool = new pg.Pool({ connectionString: process.env.VERIFY_DATABASE_URL });
      const books = new BrokerBooks(pool, s.account);
      await books.setBaseline(startCash, 'verify-ibkr-paper start balance');
      const halts: string[] = [];
      const rec = new Reconciler({
        broker, pool, accountId: s.account, currency: 'USD', allowedCashVarianceMinor: s.limits.reconciliation.allowedCashVarianceMinor,
        unresolvedOrderAfterMs: s.limits.reconciliation.unresolvedOrderAfterMs, executionOverlapMs: s.limits.reconciliation.executionOverlapMs,
        halt: async (r) => { halts.push(r); },
      });
      const r = await rec.run();
      record('books and IB agree on cash and positions after the round trip', r.status === 'OK' ? 'PASS' : 'FAIL', r.status === 'OK' ? { cash: cents(r.observed.cashMinor) } : { findings: r.findings, expectedCash: cents(r.expected.cashMinor), observedCash: cents(r.observed.cashMinor) });
      observed.reconciliation = { status: r.status, findings: r.findings };
    }
  } catch (e) {
    if (!(e instanceof StopHere)) record('unexpected error', 'FAIL', (e as Error).message);
    // never leave the paper account with a working order or a position because the check stopped halfway
    try {
      if (gateway && broker.isReady) {
        const o = await gateway.getOrder(s.account, entryId);
        if (o && (o.status === 'ACCEPTED' || o.status === 'PART_FILLED')) { await gateway.cancel(s.account, entryId); record('cleanup: unfilled entry cancelled', 'PASS'); }
        const held = (await broker.positions(s.account)).find((p) => p.instrumentId === symbol);
        const already = await gateway.getOrder(s.account, closeId);
        if (held && !already) { await gateway.place({ kind: 'CLOSE', mode: 'BROKER_PAPER', accountId: s.account, clientOrderId: `${closeId}-cleanup`, instrumentId: symbol, currency: 'USD', quantity: held.quantity }); record('cleanup: position closed', 'PASS', `${held.quantity} ${symbol}`); }
      }
    } catch (e2) { record('cleanup', 'FAIL', `${(e2 as Error).message} — check the paper account in IB Gateway / TWS by hand`); }
    try {
      await broker.refreshAll();
      const open = broker.describeOrders().filter((o) => o.symbol === symbol && ['PreSubmitted', 'Submitted', 'PendingSubmit', 'ApiPending'].includes(o.status) && o.orderRef.startsWith('verify-'));
      if (open.length) record('cleanup: working orders left by this check', 'FAIL', `${open.length} order(s) still working for ${symbol}: cancel or close them in IB Gateway / TWS`);
    } catch { /* the connection may be gone; the line above is best-effort */ }
  } finally {
    quotes?.stop();
    gateway?.close();
    broker.disconnect();
    await pool?.end().catch(() => undefined);
    rmSync(tmp, { recursive: true, force: true });
    const file = `verify-ibkr-report-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), steps, observed }, null, 2));
    const failed = steps.filter((x) => x.status === 'FAIL').length;
    console.log(`\n${failed === 0 ? 'ALL CHECKS PASSED' : failed + ' CHECK(S) FAILED'} — report: ${file}`);
    process.exitCode = failed === 0 ? 0 : 1;
  }
}
main().catch((e) => { console.error((e as Error).message); process.exit(2); });
