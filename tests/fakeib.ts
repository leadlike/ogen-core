import { EventEmitter } from 'node:events';
import type { IbClient, IbContract, IbEventMap, IbEventName, IbOrder } from '../src/broker/ibkr/client';

/**
 * A scripted stand-in for TWS / IB Gateway. It replays the API events a real session produces (as documented),
 * so the adapter's logic can be tested for acknowledgements, rejects, silence, disconnects and late commissions.
 * It is NOT IB: whether the real thing behaves this way is exactly what tools/verify-ibkr-paper.ts is for.
 */
interface Row { id: number; contract: IbContract; order: IbOrder; status: string; filled: number; avg: number; staged: boolean }
interface Ex { execId: string; row: Row; side: 'BOT' | 'SLD'; shares: number; price: number; time: string; commission: number }

export class FakeIb implements IbClient {
  private bus = new EventEmitter();
  connectedNow = false;
  readonly rows = new Map<number, Row>();
  readonly sent: Array<{ id: number; contract: IbContract; order: IbOrder }> = [];
  readonly cancelled: number[] = [];
  private execs: Ex[] = [];
  private seq = 0;
  /** account shown in managedAccounts */
  accounts = 'DU1234567';
  account = 'DU1234567';
  startId = 100;
  cash = 500;
  holdings = new Map<string, { qty: number; cost: number }>();
  /** time text printed on executions */
  clockText = '20261027  11:05:00 America/New_York';

  // scripting
  silent = false; // receive orders but never acknowledge them
  rejectNext: { code: number; message?: string } | null = null;
  errorNext: { code: number; message?: string } | null = null; // an error that does NOT reject (unknown code)
  withholdCommissions = false;
  respondToRequests = true;
  throwOnPlace: { after: number } | null = null;
  private placeCount = 0;
  positionsExtra: Array<{ symbol: string; secType: string; currency: string; pos: number; avgCost: number }> = [];
  summaryCurrency = 'USD';
  foreignExecs: Array<{ acct: string }> = [];

  get isConnected(): boolean { return this.connectedNow; }
  on<E extends IbEventName>(e: E, l: (...a: IbEventMap[E]) => void): void { this.bus.on(e, l as (...a: unknown[]) => void); }
  off<E extends IbEventName>(e: E, l: (...a: IbEventMap[E]) => void): void { this.bus.off(e, l as (...a: unknown[]) => void); }
  private emit<E extends IbEventName>(e: E, ...a: IbEventMap[E]): void { this.bus.emit(e, ...a); }
  private later(fn: () => void): void { setImmediate(fn); }

  connect(): void {
    this.later(() => {
      this.connectedNow = true;
      this.emit('connected');
      this.emit('managedAccounts', this.accounts);
      this.emit('nextValidId', this.startId);
    });
  }
  disconnect(): void { if (this.connectedNow) { this.connectedNow = false; this.later(() => this.emit('disconnected')); } }
  /** the socket dies under the adapter */
  drop(): void { this.connectedNow = false; this.emit('disconnected'); }
  reqIds(): void { this.later(() => this.emit('nextValidId', this.startId)); }

  // ---- orders ---------------------------------------------------------------
  placeOrder(id: number, contract: IbContract, order: IbOrder): void {
    this.placeCount++;
    if (this.throwOnPlace && this.placeCount > this.throwOnPlace.after) throw new Error('socket write failed');
    this.sent.push({ id, contract, order: structuredClone(order) });
    this.rows.set(id, { id, contract, order: structuredClone(order), status: 'ApiPending', filled: 0, avg: 0, staged: true });
    if (order.transmit === false) return; // staged inside TWS, not live
    if (this.silent) return;
    this.later(() => this.activate(id));
  }
  /** a transmit=true order releases itself and every staged order that names it as parent (or that it is the parent of) */
  private activate(lastId: number): void {
    const rej = this.rejectNext; this.rejectNext = null;
    const err = this.errorNext; this.errorNext = null;
    const last = this.rows.get(lastId)!;
    const P = last.order.parentId || undefined;
    const group = [...this.rows.values()].filter((r) => r.staged && (r.id === lastId || (P !== undefined && (r.id === P || r.order.parentId === P))));
    for (const r of group) r.staged = false;
    if (rej) {
      for (const r of group) { r.status = 'Inactive'; this.emit('openOrder', r.id, r.contract, r.order, { status: 'Inactive' }); this.emit('orderStatus', r.id, 'Inactive', 0, r.order.totalQuantity ?? 0, 0); }
      this.emit('error', new Error(rej.message ?? 'Order rejected'), rej.code, group[0]!.id);
      return;
    }
    for (const r of group) {
      const isChild = !!r.order.parentId;
      r.status = isChild ? 'PreSubmitted' : 'Submitted';
      this.emit('openOrder', r.id, r.contract, r.order, { status: r.status });
      this.emit('orderStatus', r.id, r.status, 0, r.order.totalQuantity ?? 0, 0);
    }
    if (err) this.emit('error', new Error(err.message ?? 'something'), err.code, group[0]!.id);
    // a market order (a close) fills only when the test says so
  }
  /** deliver the acknowledgement that `silent` held back */
  releaseSilent(): void {
    this.silent = false;
    this.activate(Math.max(...this.sent.map((x) => x.id)));
  }

  cancelOrder(id: number): void {
    this.cancelled.push(id);
    const r = this.rows.get(id);
    if (!r) return;
    this.later(() => {
      if (['Filled', 'Cancelled', 'Inactive'].includes(r.status)) return;
      r.status = 'Cancelled';
      this.emit('orderStatus', id, 'Cancelled', r.filled, (r.order.totalQuantity ?? 0) - r.filled, r.avg);
      this.emit('error', new Error('Order Canceled - reason:'), 202, id);
    });
  }

  // ---- market drivers (the "exchange") ----------------------------------------
  private byRef(ref: string): Row { const r = [...this.rows.values()].find((x) => x.order.orderRef === ref); if (!r) throw new Error('no such ref ' + ref); return r; }
  private execute(row: Row, side: 'BOT' | 'SLD', shares: number, price: number, commission: number): void {
    const filled = row.filled + shares;
    row.avg = (row.avg * row.filled + price * shares) / filled;
    row.filled = filled;
    const total = row.order.totalQuantity ?? 0;
    row.status = filled >= total ? 'Filled' : 'Submitted';
    const sym = row.contract.symbol!;
    const h = this.holdings.get(sym) ?? { qty: 0, cost: 0 };
    if (side === 'BOT') { h.qty += shares; h.cost += shares * price; this.cash -= shares * price + commission; }
    else { h.cost -= (h.cost / h.qty) * shares; h.qty -= shares; this.cash += shares * price - commission; }
    this.holdings.set(sym, h);
    const ex: Ex = { execId: `0000e0d5.${++this.seq}.01.01`, row, side, shares, price, time: this.clockText, commission };
    this.execs.push(ex);
    this.emit('orderStatus', row.id, row.status, row.filled, total - row.filled, row.avg);
    this.emit('execDetails', -1, row.contract, { orderId: row.id, execId: ex.execId, time: ex.time, acctNumber: this.account, side, shares, price, orderRef: row.order.orderRef });
    if (!this.withholdCommissions) this.emit('commissionReport', { execId: ex.execId, commission, currency: 'USD' });
  }
  private activateChildren(parent: Row): void {
    for (const c of this.rows.values()) if (c.order.parentId === parent.id && c.status === 'PreSubmitted') { c.status = 'Submitted'; this.emit('orderStatus', c.id, 'Submitted', 0, c.order.totalQuantity ?? 0, 0); }
  }
  /** the entry fills `shares` (cumulative effect: call again for more) */
  fillEntry(cid: string, shares: number, price: number, commission = 1): void {
    const p = this.byRef(cid);
    this.execute(p, 'BOT', shares, price, commission);
    this.activateChildren(p);
  }
  private cancelGroupMates(row: Row): void {
    for (const r of this.rows.values()) {
      if (r !== row && r.order.ocaGroup && r.order.ocaGroup === row.order.ocaGroup && !['Filled', 'Cancelled', 'Inactive'].includes(r.status)) {
        r.status = 'Cancelled'; this.emit('orderStatus', r.id, 'Cancelled', r.filled, 0, r.avg);
      }
    }
  }
  fillStop(cid: string, price: number, commission = 1): void { const r = this.byRef(cid + '#STP'); this.execute(r, 'SLD', r.order.totalQuantity!, price, commission); this.cancelGroupMates(r); }
  fillTarget(cid: string, price: number, commission = 1): void { const r = this.byRef(cid + '#TGT'); this.execute(r, 'SLD', r.order.totalQuantity!, price, commission); this.cancelGroupMates(r); }
  fillClose(cid: string, price: number, commission = 1): void { const r = this.byRef(cid); this.execute(r, 'SLD', r.order.totalQuantity!, price, commission); this.cancelGroupMates(r); }
  ack(cid: string): void { const r = this.byRef(cid); if (r.status === 'ApiPending') { r.status = 'Submitted'; this.emit('orderStatus', r.id, 'Submitted', 0, r.order.totalQuantity ?? 0, 0); } }
  /** commissions that were withheld are now delivered */
  deliverCommissions(): void { for (const e of this.execs) this.emit('commissionReport', { execId: e.execId, commission: e.commission, currency: 'USD' }); this.withholdCommissions = false; }
  /** a trade made in the account by someone else (another client, the mobile app) */
  manualTrade(symbol: string, side: 'BOT' | 'SLD', shares: number, price: number, commission = 1): void {
    const row: Row = { id: 9000 + this.seq, contract: { symbol, secType: 'STK', currency: 'USD' }, order: { orderRef: '', action: side === 'BOT' ? 'BUY' : 'SELL', totalQuantity: shares }, status: 'Filled', filled: 0, avg: 0, staged: false };
    this.rows.set(row.id, row);
    this.execute(row, side, shares, price, commission);
  }

  // ---- requests ----------------------------------------------------------------
  reqAllOpenOrders(): void {
    if (!this.respondToRequests) return;
    this.later(() => {
      for (const r of this.rows.values()) if (!r.staged && ['ApiPending', 'PreSubmitted', 'Submitted', 'PendingCancel'].includes(r.status) && !(this.silent && r.status === 'ApiPending')) this.emit('openOrder', r.id, r.contract, r.order, { status: r.status });
      this.emit('openOrderEnd');
    });
  }
  reqCompletedOrders(): void {
    if (!this.respondToRequests) return;
    this.later(() => {
      for (const r of this.rows.values()) if (['Filled', 'Cancelled', 'Inactive'].includes(r.status)) this.emit('completedOrder', r.contract, { ...r.order, orderId: 0, filledQuantity: r.filled }, { status: r.status });
      this.emit('completedOrdersEnd');
    });
  }
  reqExecutions(reqId: number): void {
    if (!this.respondToRequests) return;
    this.later(() => {
      for (const e of this.execs) {
        this.emit('execDetails', reqId, e.row.contract, { orderId: e.row.id, execId: e.execId, time: e.time, acctNumber: this.account, side: e.side, shares: e.shares, price: e.price, orderRef: e.row.order.orderRef });
        if (!this.withholdCommissions) this.emit('commissionReport', { execId: e.execId, commission: e.commission, currency: 'USD' });
      }
      for (const f of this.foreignExecs) this.emit('execDetails', reqId, { symbol: 'XXX', secType: 'STK', currency: 'USD' }, { orderId: 1, execId: 'foreign.1', time: this.clockText, acctNumber: f.acct, side: 'BOT', shares: 1, price: 1, orderRef: '' });
      this.emit('execDetailsEnd', reqId);
    });
  }
  reqPositions(): void {
    if (!this.respondToRequests) return;
    this.later(() => {
      for (const [symbol, h] of this.holdings) if (h.qty > 0) this.emit('position', this.account, { symbol, secType: 'STK', currency: 'USD' }, h.qty, h.cost / h.qty);
      for (const p of this.positionsExtra) this.emit('position', this.account, { symbol: p.symbol, secType: p.secType, currency: p.currency }, p.pos, p.avgCost);
      this.emit('position', 'DU0000000', { symbol: 'OTHER', secType: 'STK', currency: 'USD' }, 5, 1); // another account: must be ignored
      this.emit('positionEnd');
    });
  }
  cancelPositions(): void { /* nothing */ }
  reqAccountSummary(reqId: number): void {
    if (!this.respondToRequests) return;
    this.later(() => {
      this.emit('accountSummary', reqId, this.account, 'TotalCashValue', this.cash.toFixed(4), this.summaryCurrency);
      this.emit('accountSummaryEnd', reqId);
    });
  }
  cancelAccountSummary(): void { /* nothing */ }
  reqRealTimeMarketData(): void { /* nothing */ }
  readonly mktData = new Map<number, string>();
  reqMktData(reqId: number, c: IbContract): void { this.mktData.set(reqId, c.symbol!); }
  cancelMktData(reqId: number): void { this.mktData.delete(reqId); }
  tick(reqId: number, field: number, value: number): void { this.emit('tickPrice', reqId, field, value); }
}
