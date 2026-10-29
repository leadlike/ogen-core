import { describe, expect, it } from 'vitest';
import { IbkrBroker } from '../src/broker/ibkr/broker';
import { fromMinor, parseExecTime, toMinor, wholeShares } from '../src/broker/ibkr/convert';
import { OrderRefused, type BuyBracketIntent, type CloseIntent } from '../src/broker/types';
import { FakeIb } from './fakeib';

const ACCT = 'DU1234567';
const buy = (id: string, over: Partial<BuyBracketIntent> = {}): BuyBracketIntent => ({
  kind: 'BUY_BRACKET', mode: 'BROKER_PAPER', accountId: ACCT, clientOrderId: id, instrumentId: 'SPY', currency: 'USD',
  quantity: '3', entryLimitMinor: '2500', stopMinor: '2400', targetMinor: '2800', ...over,
});
const close = (id: string, quantity = '3', instrumentId = 'SPY'): CloseIntent => ({
  kind: 'CLOSE', mode: 'BROKER_PAPER', accountId: ACCT, clientOrderId: id, instrumentId, currency: 'USD', quantity,
});

async function world(opts: Partial<ConstructorParameters<typeof IbkrBroker>[1]> = {}) {
  const ib = new FakeIb();
  const broker = new IbkrBroker(ib, { accountId: ACCT, ackTimeoutMs: 150, requestTimeoutMs: 150, commissionWaitMs: 100, ...opts });
  await broker.connect(1000);
  return { ib, broker };
}
const code = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e instanceof OrderRefused ? e.code : `ERR:${(e as Error).message}`; } return 'OK'; };

describe('conversions at the IB boundary', () => {
  it('turns prices into exact cents and back, without float surprises', () => {
    expect(toMinor(123.45)).toBe(12345n);
    expect(toMinor(0.1 + 0.2)).toBe(30n);
    expect(toMinor(1.005)).toBe(101n); // half a cent rounds up, the 1e-6 guard absorbs binary error
    expect(toMinor(0.3512, 'ceil')).toBe(36n); // fees round up, never down
    expect(toMinor(1, 'ceil')).toBe(100n);
    expect(() => toMinor(NaN)).toThrow();
    expect(() => toMinor(-1)).toThrow();
    expect(fromMinor('12345')).toBe(123.45);
    expect(fromMinor('5')).toBe(0.05);
    expect(fromMinor(100n)).toBe(1);
  });
  it('accepts whole non-negative shares only', () => {
    expect(wholeShares(3)).toBe(3n);
    expect(() => wholeShares(1.5)).toThrow(/NON_WHOLE/);
    expect(() => wholeShares(-1)).toThrow();
  });
  it('reads execution times in the zone they carry, UTC when dashed, the default zone otherwise, across daylight saving', () => {
    expect(parseExecTime('20261027  11:05:00 America/New_York', 'Asia/Tokyo')).toBe(Date.UTC(2026, 9, 27, 15, 5, 0)); // EDT
    expect(parseExecTime('20261103  11:05:00 America/New_York', 'Asia/Tokyo')).toBe(Date.UTC(2026, 10, 3, 16, 5, 0)); // EST
    expect(parseExecTime('20261027-15:05:00', 'Asia/Tokyo')).toBe(Date.UTC(2026, 9, 27, 15, 5, 0));
    expect(parseExecTime('20261027 11:05:00', 'America/New_York')).toBe(Date.UTC(2026, 9, 27, 15, 5, 0));
    expect(() => parseExecTime('yesterday', 'UTC')).toThrow(/BAD_TIME/);
  });
});

describe('connection and account guards', () => {
  it('refuses anything that is not a paper account', () => {
    expect(() => new IbkrBroker(new FakeIb(), { accountId: 'U1234567' })).toThrow(/PAPER_ACCOUNT_REQUIRED/);
  });
  it('refuses to stay connected to a session where the paper account is not logged in', async () => {
    const ib = new FakeIb(); ib.accounts = 'DU7777777';
    const broker = new IbkrBroker(ib, { accountId: ACCT });
    await expect(broker.connect(500)).rejects.toThrow(/NOT_LOGGED_IN/);
  });
  it('refuses a request for another account', async () => {
    const { broker } = await world();
    expect(await code(broker.account('DU0000001'))).toBe('WRONG_ACCOUNT');
    expect(await code(broker.place(buy('x', { accountId: 'DU0000001' })))).toBe('WRONG_ACCOUNT');
  });
  it('refuses to place when not connected, and never sends', async () => {
    const ib = new FakeIb();
    const broker = new IbkrBroker(ib, { accountId: ACCT });
    expect(await code(broker.place(buy('a')))).toBe('IB_NOT_CONNECTED');
    expect(ib.sent).toHaveLength(0);
  });
  it('refuses new orders while IB servers are unreachable, and resumes when connectivity is restored', async () => {
    const { ib, broker } = await world();
    ib['emit']('error', new Error('connectivity lost'), 1100, -1);
    expect(await code(broker.place(buy('a')))).toBe('IB_LINK_DOWN');
    expect(ib.sent).toHaveLength(0);
    ib['emit']('error', new Error('restored'), 1102, -1);
    expect(await code(broker.place(buy('b')))).toBe('OK');
  });
  it('only moves its order id counter forward across reconnects, so an id is never reused', async () => {
    const { ib, broker } = await world();
    await broker.place(buy('a')); // uses 100,101,102
    ib.startId = 50; // a stale value after a reconnect
    ib['emit']('nextValidId', 50);
    await broker.place(buy('b', { instrumentId: 'QQQ' }));
    expect(ib.sent.map((s) => s.id)).toEqual([100, 101, 102, 103, 104, 105]);
    ib['emit']('nextValidId', 500);
    await broker.place(buy('c', { instrumentId: 'IWM' }));
    expect(ib.sent.at(-1)!.id).toBe(502);
  });
});

describe('placing a bracket', () => {
  it('sends parent + stop + target as one staged unit, carries our id in orderRef, prices in decimals, no extended hours', async () => {
    const { ib, broker } = await world();
    const o = await broker.place(buy('ord-1'));
    expect(ib.sent).toHaveLength(3);
    const [p, s, t] = ib.sent.map((x) => x.order);
    expect(p).toMatchObject({ action: 'BUY', orderType: 'LMT', lmtPrice: 25, totalQuantity: 3, tif: 'DAY', outsideRth: false, orderRef: 'ord-1', transmit: false, account: ACCT });
    expect(s).toMatchObject({ action: 'SELL', orderType: 'STP', auxPrice: 24, parentId: 100, tif: 'GTC', orderRef: 'ord-1#STP', ocaGroup: 'ord-1', ocaType: 1, transmit: false });
    expect(t).toMatchObject({ action: 'SELL', orderType: 'LMT', lmtPrice: 28, parentId: 100, orderRef: 'ord-1#TGT', ocaGroup: 'ord-1', ocaType: 1, transmit: true });
    expect(ib.sent.every((x) => x.contract.secType === 'STK' && x.contract.currency === 'USD' && x.contract.symbol === 'SPY')).toBe(true);
    expect(o).toMatchObject({ clientOrderId: 'ord-1', status: 'ACCEPTED', filledQuantity: '0', protectedQuantity: '0', brokerOrderId: '100' });
  });
  it('is idempotent: the same client id again returns the order and sends nothing more', async () => {
    const { ib, broker } = await world();
    await broker.place(buy('dup'));
    const again = await broker.place(buy('dup'));
    expect(again.status).toBe('ACCEPTED');
    expect(ib.sent).toHaveLength(3);
  });
  it('rejects ids the orderRef scheme cannot carry', async () => {
    const { ib, broker } = await world();
    expect(await code(broker.place(buy('a#STP')))).toBe('CLIENT_ORDER_ID_RESERVED_CHAR');
    expect(await code(broker.place(buy('x'.repeat(101))))).toBe('CLIENT_ORDER_ID_TOO_LONG');
    expect(ib.sent).toHaveLength(0);
  });
  it('a fill activates the protection: protectedQuantity equals the shares held, average price in cents', async () => {
    const { ib, broker } = await world();
    await broker.place(buy('f1'));
    ib.fillEntry('f1', 3, 24.99);
    const o = (await broker.getOrder(ACCT, 'f1'))!;
    expect(o).toMatchObject({ status: 'FILLED', filledQuantity: '3', averageFillMinor: '2499', protectedQuantity: '3', exitedQuantity: '0', exitReason: null });
  });
  it('a partial fill protects only the filled shares', async () => {
    const { ib, broker } = await world();
    await broker.place(buy('p1'));
    ib.fillEntry('p1', 1, 25);
    const o = (await broker.getOrder(ACCT, 'p1'))!;
    expect(o).toMatchObject({ status: 'PART_FILLED', filledQuantity: '1', protectedQuantity: '1' });
    ib.fillEntry('p1', 2, 24.5); // weighted average (25 + 2 x 24.5) / 3 = 24.67
    expect((await broker.getOrder(ACCT, 'p1'))!).toMatchObject({ status: 'FILLED', filledQuantity: '3', averageFillMinor: '2467', protectedQuantity: '3' });
  });
  it('a stop that fires at the broker is seen as an exit with reason STOP, and the target is gone', async () => {
    const { ib, broker } = await world();
    await broker.place(buy('s1'));
    ib.fillEntry('s1', 3, 25);
    ib.fillStop('s1', 23.9);
    expect(await broker.getOrder(ACCT, 's1')).toMatchObject({ status: 'FILLED', exitedQuantity: '3', exitReason: 'STOP', protectedQuantity: '0' });
    expect(await broker.positions(ACCT)).toEqual([]);
  });
  it('a target that fires is an exit with reason TARGET', async () => {
    const { ib, broker } = await world();
    await broker.place(buy('t1'));
    ib.fillEntry('t1', 3, 25);
    ib.fillTarget('t1', 28);
    expect(await broker.getOrder(ACCT, 't1')).toMatchObject({ exitedQuantity: '3', exitReason: 'TARGET', protectedQuantity: '0' });
  });
  it('a stop/target pair that IB cancelled leaves held shares unprotected, and says so', async () => {
    const { ib, broker } = await world();
    await broker.place(buy('u1'));
    ib.fillEntry('u1', 3, 25);
    ib.cancelOrder(101); // somebody cancels the stop by hand
    await new Promise((r) => setImmediate(r));
    expect((await broker.getOrder(ACCT, 'u1'))!.protectedQuantity).toBe('0');
  });
});

describe('what happens when TWS refuses or says nothing', () => {
  it('a definite reject is a refusal, and the bracket is not left live', async () => {
    const { ib, broker } = await world();
    ib.rejectNext = { code: 201, message: 'Order rejected - reason: insufficient buying power' };
    expect(await code(broker.place(buy('r1')))).toBe('IB_201');
    expect([...ib.rows.values()].every((r) => r.status === 'Inactive')).toBe(true);
    expect(await broker.getOrder(ACCT, 'r1')).toMatchObject({ status: 'REJECTED', filledQuantity: '0' });
  });
  it('an error code the adapter does not recognise is UNCERTAIN, not a refusal', async () => {
    const { ib, broker } = await world();
    ib.errorNext = { code: 10168, message: 'something unknown' };
    const out = await code(broker.place(buy('w1')));
    expect(out).toBe('OK'); // the order was acknowledged anyway; the unknown error did not turn into a false refusal
    expect((await broker.getOrder(ACCT, 'w1'))!.status).toBe('ACCEPTED');
  });
  it('silence is UNCERTAIN (a plain error), the order is then found by lookup and never resent', async () => {
    const { ib, broker } = await world();
    ib.silent = true;
    const out = await code(broker.place(buy('q1')));
    expect(out).toBe('ERR:IB_ACK_TIMEOUT');
    expect(ib.sent).toHaveLength(3);
    // TWS had it all along; the acknowledgement was just late
    ib.releaseSilent();
    await new Promise((r) => setImmediate(r));
    expect(await broker.getOrder(ACCT, 'q1')).toMatchObject({ status: 'ACCEPTED' });
    expect(await code(broker.place(buy('q1')))).toBe('OK');
    expect(ib.sent).toHaveLength(3);
  });
  it('a socket that fails while writing the last order is UNCERTAIN; before it, nothing is live and it is a refusal', async () => {
    const a = await world();
    a.ib.throwOnPlace = { after: 2 };
    expect(await code(a.broker.place(buy('x1')))).toMatch(/^ERR:IB_SEND_UNCERTAIN/);
    const b = await world();
    b.ib.throwOnPlace = { after: 0 };
    expect(await code(b.broker.place(buy('x2')))).toBe('IB_SEND_FAILED');
  });
  it('a lookup that gets no answer fails loudly instead of answering "no such order"', async () => {
    const { ib, broker } = await world();
    await broker.place(buy('z1'));
    ib.respondToRequests = false;
    expect(await code(broker.getOrder(ACCT, 'z1'))).toBe('ERR:IB_ORDERS_TIMEOUT');
  });
  it('an id IB has never seen is null once IB has answered completely', async () => {
    const { broker } = await world();
    expect(await broker.getOrder(ACCT, 'never-sent')).toBeNull();
  });
  it('a restart (new adapter, same IB) still finds the bracket by orderRef and sees its fills', async () => {
    const { ib, broker } = await world();
    await broker.place(buy('rs1'));
    ib.fillEntry('rs1', 3, 25);
    broker.disconnect();
    const fresh = new IbkrBroker(ib, { accountId: ACCT, ackTimeoutMs: 150, requestTimeoutMs: 150, commissionWaitMs: 100 });
    await fresh.connect(1000);
    expect(await fresh.getOrder(ACCT, 'rs1')).toMatchObject({ status: 'FILLED', filledQuantity: '3', averageFillMinor: '2500', protectedQuantity: '3' });
    ib.fillStop('rs1', 24);
    expect(await fresh.getOrder(ACCT, 'rs1')).toMatchObject({ exitReason: 'STOP' }); // the stop's own fills are found in completed orders
  });
});

describe('closing a position', () => {
  async function held() {
    const w = await world();
    await w.broker.place(buy('b1'));
    w.ib.fillEntry('b1', 3, 25);
    return w;
  }
  it('sells the whole position at market inside the bracket\'s OCA group, so the old stop cannot sell again', async () => {
    const { ib, broker } = await held();
    const o = await broker.place(close('c1'));
    const sent = ib.sent.at(-1)!.order;
    expect(sent).toMatchObject({ action: 'SELL', orderType: 'MKT', totalQuantity: 3, orderRef: 'c1', ocaGroup: 'b1', ocaType: 1, tif: 'DAY', outsideRth: false, transmit: true });
    expect(o.status).toBe('ACCEPTED');
    ib.fillClose('c1', 25.2);
    expect(await broker.getOrder(ACCT, 'c1')).toMatchObject({ status: 'FILLED', filledQuantity: '3', averageFillMinor: '2520' });
    expect(await broker.getOrder(ACCT, 'b1')).toMatchObject({ exitedQuantity: '3', exitReason: 'CLOSE', protectedQuantity: '0' });
    expect(await broker.positions(ACCT)).toEqual([]);
    // the stop and target were cancelled by IB, not left to fire
    expect(ib.rows.get(101)!.status).toBe('Cancelled');
    expect(ib.rows.get(102)!.status).toBe('Cancelled');
  });
  it('refuses to sell more than is held, and to sell part of a position', async () => {
    const { ib, broker } = await held();
    const before = ib.sent.length;
    expect(await code(broker.place(close('c2', '4')))).toBe('NO_POSITION_TO_CLOSE');
    expect(await code(broker.place(close('c3', '1')))).toBe('PARTIAL_CLOSE_UNSUPPORTED');
    expect(await code(broker.place(close('c4', '1', 'QQQ')))).toBe('NO_POSITION_TO_CLOSE');
    expect(ib.sent.length).toBe(before);
  });
  it('refuses to close while a sell order it does not know is working', async () => {
    const { ib, broker } = await held();
    ib.rows.set(777, { id: 777, contract: { symbol: 'SPY', secType: 'STK', currency: 'USD' }, order: { action: 'SELL', orderType: 'LMT', totalQuantity: 3, orderRef: 'manual' }, status: 'Submitted', filled: 0, avg: 0, staged: false });
    expect(await code(broker.place(close('c5')))).toBe('UNKNOWN_SELL_ORDERS_OPEN');
  });
  it('a close that nobody acknowledges is uncertain, found later by lookup', async () => {
    const { ib, broker } = await held();
    ib.silent = true;
    expect(await code(broker.place(close('c6')))).toBe('ERR:IB_ACK_TIMEOUT');
    expect(ib.sent.filter((s) => s.order.orderRef === 'c6')).toHaveLength(1);
  });
});

describe('cancelling', () => {
  it('cancels an unfilled entry', async () => {
    const { broker } = await world();
    await broker.place(buy('k1'));
    expect(await broker.cancel(ACCT, 'k1')).toMatchObject({ status: 'CANCELED', filledQuantity: '0' });
  });
  it('cancelling a part-filled entry stops the rest of the buying, and keeps the stop on what was bought', async () => {
    const { ib, broker } = await world();
    await broker.place(buy('k2'));
    ib.fillEntry('k2', 1, 25);
    const o = await broker.cancel(ACCT, 'k2');
    expect(o).toMatchObject({ status: 'CANCELED', filledQuantity: '1', protectedQuantity: '1' });
  });
  it('cancelling something unknown is an error, not a success', async () => {
    const { broker } = await world();
    expect(await code(broker.cancel(ACCT, 'nope'))).toBe('ERR:ORDER_NOT_FOUND');
  });
});

describe('account and positions', () => {
  it('reads cash in cents and holdings with cost; other accounts are ignored', async () => {
    const { ib, broker } = await world();
    await broker.place(buy('a1'));
    ib.fillEntry('a1', 3, 25, 1);
    expect(await broker.account(ACCT)).toEqual({ id: ACCT, mode: 'BROKER_PAPER', currency: 'USD', cashMinor: '42400' }); // 500 - 75 - 1
    expect(await broker.positions(ACCT)).toEqual([{ instrumentId: 'SPY', quantity: '3', costMinor: '7500' }]);
  });
  it('refuses a cash balance that is not in USD', async () => {
    const { ib, broker } = await world();
    ib.summaryCurrency = 'EUR';
    expect(await code(broker.account(ACCT))).toMatch(/IB_CASH_NOT_USD/);
  });
  it('refuses holdings it cannot represent: shorts, fractions, other currencies, other security types', async () => {
    for (const extra of [
      { symbol: 'AAA', secType: 'STK', currency: 'USD', pos: -2, avgCost: 10 },
      { symbol: 'AAA', secType: 'STK', currency: 'USD', pos: 1.5, avgCost: 10 },
      { symbol: 'AAA', secType: 'STK', currency: 'EUR', pos: 1, avgCost: 10 },
      { symbol: 'AAA', secType: 'OPT', currency: 'USD', pos: 1, avgCost: 10 },
    ]) {
      const { ib, broker } = await world();
      ib.positionsExtra = [extra];
      expect(await code(broker.positions(ACCT))).toMatch(/^ERR:IB_(SHORT_POSITION|NON_WHOLE_POSITION|UNSUPPORTED_HOLDING)/);
    }
  });
  it('a request that never completes is an error, not an empty answer', async () => {
    const { ib, broker } = await world();
    ib.respondToRequests = false;
    expect(await code(broker.positions(ACCT))).toBe('ERR:IB_POSITIONS_TIMEOUT');
    expect(await code(broker.account(ACCT))).toBe('ERR:IB_ACCOUNT_TIMEOUT');
  });
});

describe('executions and commissions', () => {
  it('reports each fill with its real commission in cents (rounded up), attributed to our client id', async () => {
    const { ib, broker } = await world();
    await broker.place(buy('e1'));
    ib.fillEntry('e1', 3, 25, 1.0042);
    ib.fillStop('e1', 24, 1.0042);
    const ex = await broker.executions(ACCT, 0);
    expect(ex).toHaveLength(2);
    expect(ex[0]).toMatchObject({ clientOrderId: 'e1', instrumentId: 'SPY', side: 'BUY', quantity: '3', priceMinor: '2500', feeMinor: '101' });
    expect(ex[1]).toMatchObject({ clientOrderId: 'e1', side: 'SELL', priceMinor: '2400', feeMinor: '101' }); // the #STP suffix is not leaked
    expect(new Set(ex.map((e) => e.executionId)).size).toBe(2);
    expect(ex[0]!.atMs).toBe(Date.UTC(2026, 9, 27, 15, 5, 0));
  });
  it('filters by time', async () => {
    const { ib, broker } = await world();
    await broker.place(buy('e2'));
    ib.fillEntry('e2', 3, 25);
    expect(await broker.executions(ACCT, Date.UTC(2026, 9, 27, 15, 5, 1))).toEqual([]);
    expect(await broker.executions(ACCT, Date.UTC(2026, 9, 27, 15, 5, 0))).toHaveLength(1);
  });
  it('does not invent a zero fee while the commission report is missing: it fails, and succeeds once the report arrives', async () => {
    const { ib, broker } = await world();
    ib.withholdCommissions = true;
    await broker.place(buy('e3'));
    ib.fillEntry('e3', 3, 25, 1);
    expect(await code(broker.executions(ACCT, 0))).toMatch(/^ERR:COMMISSION_PENDING: 1/);
    ib.deliverCommissions();
    expect((await broker.executions(ACCT, 0))[0]!.feeMinor).toBe('100');
  });
  it('a commission report that arrives during the wait is used', async () => {
    const { ib, broker } = await world({ commissionWaitMs: 500 });
    ib.withholdCommissions = true;
    await broker.place(buy('e4'));
    ib.fillEntry('e4', 3, 25, 1);
    setTimeout(() => ib.deliverCommissions(), 50);
    expect(await broker.executions(ACCT, 0)).toHaveLength(1);
  });
  it('a trade made outside our order ids has no client id, and other accounts\' trades are ignored', async () => {
    const { ib, broker } = await world();
    ib.manualTrade('QQQ', 'BOT', 1, 30);
    ib.foreignExecs = [{ acct: 'DU0000001' }];
    const ex = await broker.executions(ACCT, 0);
    expect(ex).toHaveLength(1);
    expect(ex[0]).toMatchObject({ clientOrderId: null, instrumentId: 'QQQ' });
  });
  it('refuses a fractional execution instead of rounding it', async () => {
    const { ib, broker } = await world();
    ib.manualTrade('QQQ', 'BOT', 1.5, 30);
    expect(await code(broker.executions(ACCT, 0))).toMatch(/NON_WHOLE_EXECUTION/);
  });
});
