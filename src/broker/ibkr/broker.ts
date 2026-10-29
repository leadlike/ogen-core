import { EventEmitter } from 'node:events';
import {
  integer, OrderRefused, validateIntent,
  type Broker, type BrokerAccount, type BrokerOrder, type BrokerOrderStatus, type BrokerPosition, type BuyBracketIntent, type CloseIntent, type ExitReason, type Execution, type OrderIntent,
} from '../types';
import type { IbClient, IbCommission, IbContract, IbEventMap, IbExecution, IbOrder } from './client';
import { fromMinor, parseExecTime, toMinor, wholeShares } from './convert';

export const STOP_SUFFIX = '#STP';
export const TARGET_SUFFIX = '#TGT';

export interface IbkrBrokerOptions {
  /** the paper account (DU...) every call is checked against */
  accountId: string;
  /** how long to wait for TWS to acknowledge an order before the outcome is declared uncertain */
  ackTimeoutMs?: number;
  /** how long to wait for a data request (positions, open orders, executions...) */
  requestTimeoutMs?: number;
  /** how long to wait for the commission report that follows an execution */
  commissionWaitMs?: number;
  /** zone IB Gateway prints execution times in when the text carries none */
  execTimeZone?: string;
  /** reconnect by itself after a socket drop (off in tests) */
  autoReconnectMs?: number;
}

/** Codes that mean "TWS refused this order and nothing is live because of it". Anything else on an order is UNCERTAIN. */
const DEFINITE_REJECT = new Set([103, 110, 200, 201, 203]);
/** Connectivity between TWS and IB's servers broken / restored. */
const LINK_DOWN = new Set([1100, 2110]);
const LINK_UP = new Set([1101, 1102]);

const WORKING = new Set(['ApiPending', 'PendingSubmit', 'PreSubmitted', 'Submitted', 'PendingCancel']);
const LIVE_AT_EXCHANGE = new Set(['PreSubmitted', 'Submitted']);
const DEAD = new Set(['Cancelled', 'ApiCancelled', 'Inactive']);
const KNOWN = new Set([...WORKING, ...DEAD, 'Filled']);

interface OrderRec {
  orderId: number; orderRef: string; symbol: string; action: string; type: string; qty: number;
  parentId: number; oca: string; status: string; filled: number; avg: number;
}
interface ExecRec { execId: string; orderRef: string; symbol: string; side: 'BUY' | 'SELL'; shares: number; price: number; atMs: number }

class Mutex {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> { const r = this.tail.then(fn, fn); this.tail = r.catch(() => undefined); return r; }
}

/**
 * Interactive Brokers (paper) behind the Broker interface. It lives inside the risk gateway process, the only
 * place that talks to IB Gateway. Everything is keyed by our client order id, carried in IB's orderRef:
 *   entry  = <id>        stop = <id>#STP        target = <id>#TGT        close = <id>
 * so after any crash or timeout the question "did this order exist?" is answered from IB, never from memory.
 *
 * What is NOT verified here (no IB Gateway is reachable from the build environment): the exact event sequence,
 * partial-fill behaviour of bracket children, OCA joining, and which fees IB itemises. See tools/verify-ibkr-paper.ts.
 */
export class IbkrBroker implements Broker {
  readonly capabilities = { paper: true, atomicBracket: true, partialFillProtection: true, lookupByClientId: true };

  private bus = new EventEmitter();
  private orders = new Map<number, OrderRec>();
  private execs = new Map<string, ExecRec>();
  private commissions = new Map<string, { commission: number; currency: string }>();
  private orderErrors = new Map<number, { code: number; message: string }>();
  private nextId = 0;
  private connected = false;
  private linkUp = true;
  private managed: string[] = [];
  private reqSeq = 1000;
  private requests = new Mutex();
  private timer: NodeJS.Timeout | null = null;
  private wantConnected = false;

  // request scratch space
  private openDone = false; private completedDone = false; private execDone = new Set<number>(); private posDone = false;
  private posRows: Array<{ contract: IbContract; pos: number; avgCost: number }> = [];
  private summary: Array<{ tag: string; value: string; currency: string }> = [];
  private summaryDone = new Set<number>();

  private ackMs: number; private reqMs: number; private commMs: number; private tz: string;

  constructor(private client: IbClient, private o: IbkrBrokerOptions) {
    if (!/^DU\d+$/.test(o.accountId)) throw new Error('PAPER_ACCOUNT_REQUIRED: this build only talks to IB paper accounts (DU...)');
    this.ackMs = o.ackTimeoutMs ?? 8_000;
    this.reqMs = o.requestTimeoutMs ?? 10_000;
    this.commMs = o.commissionWaitMs ?? 5_000;
    this.tz = o.execTimeZone ?? 'America/New_York';
    this.bus.setMaxListeners(100);
    this.wire();
  }

  // ---- connection ---------------------------------------------------------
  async connect(timeoutMs = 15_000): Promise<void> {
    this.wantConnected = true;
    this.managed = [];
    this.client.connect();
    const ok = await this.until(() => this.connected && this.managed.length > 0, timeoutMs);
    if (!ok) { this.client.disconnect(); throw new Error('IB_CONNECT_TIMEOUT'); }
    if (!this.managed.includes(this.o.accountId)) {
      this.wantConnected = false;
      this.client.disconnect();
      throw new Error(`IB_ACCOUNT_NOT_LOGGED_IN: ${this.o.accountId} is not among the accounts of this session`);
    }
  }
  disconnect(): void {
    this.wantConnected = false;
    if (this.timer) clearTimeout(this.timer);
    this.client.disconnect();
    this.connected = false;
  }
  get isReady(): boolean { return this.connected && this.linkUp; }

  private wire(): void {
    const c = this.client;
    c.on('connected', () => { this.connected = true; this.ping(); });
    c.on('disconnected', () => {
      this.connected = false; this.ping();
      if (this.wantConnected && this.o.autoReconnectMs) {
        this.timer = setTimeout(() => { this.connect().catch(() => undefined); }, this.o.autoReconnectMs);
        this.timer.unref();
      }
    });
    // IB keeps the next free id; a fresh value arrives on every (re)connection and may only move our counter forward
    c.on('nextValidId', (id) => { if (id > this.nextId) this.nextId = id; this.connected = true; this.ping(); });
    c.on('managedAccounts', (list) => { this.managed = list.split(',').map((s) => s.trim()).filter(Boolean); this.ping(); });
    c.on('error', (err, code, reqId) => {
      if (LINK_DOWN.has(code)) this.linkUp = false;
      if (LINK_UP.has(code)) this.linkUp = true;
      if (code === 502 || code === 504 || code === 1300) this.connected = false;
      if (reqId > 0) this.orderErrors.set(reqId, { code, message: err?.message ?? '' });
      this.ping();
    });
    c.on('openOrder', (id, contract, o, st) => { this.upsert(id, contract, o, st.status); this.ping(); });
    c.on('openOrderEnd', () => { this.openDone = true; this.ping(); });
    c.on('completedOrder', (contract, o, st) => { this.upsertCompleted(contract, o, st.status); this.ping(); });
    c.on('completedOrdersEnd', () => { this.completedDone = true; this.ping(); });
    c.on('orderStatus', (id, status, filled, _remaining, avg, _perm, parent) => {
      const r = this.orders.get(id);
      if (r) { r.status = status; r.filled = filled; r.avg = avg; if (parent) r.parentId = parent; }
      this.ping();
    });
    c.on('execDetails', (_req, contract, e) => { this.storeExec(contract, e); this.ping(); });
    c.on('execDetailsEnd', (req) => { this.execDone.add(req); this.ping(); });
    c.on('commissionReport', (r: IbCommission) => {
      if (r.execId && typeof r.commission === 'number' && Number.isFinite(r.commission)) this.commissions.set(r.execId, { commission: r.commission, currency: r.currency ?? 'USD' });
      this.ping();
    });
    c.on('position', (acct, contract, pos, avg) => { if (acct === this.o.accountId) this.posRows.push({ contract, pos, avgCost: avg ?? 0 }); });
    c.on('positionEnd', () => { this.posDone = true; this.ping(); });
    c.on('accountSummary', (_req, acct, tag, value, currency) => { if (acct === this.o.accountId) this.summary.push({ tag, value, currency }); });
    c.on('accountSummaryEnd', (req) => { this.summaryDone.add(req); this.ping(); });
  }

  private ping(): void { this.bus.emit('c'); }
  private until(cond: () => boolean, ms: number): Promise<boolean> {
    if (cond()) return Promise.resolve(true);
    return new Promise((resolve) => {
      const done = (v: boolean) => { clearTimeout(t); this.bus.off('c', h); resolve(v); };
      const h = () => { if (cond()) done(true); };
      const t = setTimeout(() => done(false), ms);
      this.bus.on('c', h);
    });
  }

  private upsert(id: number, contract: IbContract, o: IbEventMap['openOrder'][2], status: string | undefined, filled?: number): void {
    const prev = this.orders.get(id);
    this.orders.set(id, {
      orderId: id, orderRef: o.orderRef ?? prev?.orderRef ?? '', symbol: contract.symbol ?? prev?.symbol ?? '',
      action: o.action ?? prev?.action ?? '', type: o.orderType ?? prev?.type ?? '', qty: o.totalQuantity ?? prev?.qty ?? 0,
      parentId: o.parentId ?? prev?.parentId ?? 0, oca: o.ocaGroup ?? prev?.oca ?? '',
      status: status ?? prev?.status ?? 'Unknown', filled: filled ?? prev?.filled ?? 0, avg: prev?.avg ?? 0,
    });
  }
  /**
   * Completed orders (finished in an earlier session or earlier today) come with order id 0, so they are matched on
   * (orderRef, action, symbol). A match is updated, because the completed record is the final word on its status.
   */
  private synth = 0;
  private upsertCompleted(contract: IbContract, o: IbEventMap['openOrder'][2], status: string | undefined): void {
    if (!o.orderRef) return;
    const same = [...this.orders.values()].find((r) => r.orderRef === o.orderRef && r.action === o.action && r.symbol === contract.symbol);
    if (same) {
      if (status) same.status = status;
      if (typeof o.filledQuantity === 'number' && o.filledQuantity > same.filled) same.filled = o.filledQuantity;
      if (o.ocaGroup) same.oca = o.ocaGroup;
      if (o.parentId) same.parentId = o.parentId;
      return;
    }
    this.upsert(--this.synth, contract, o, status, o.filledQuantity);
  }
  private storeExec(contract: IbContract, e: IbExecution): void {
    if (!e.execId || e.acctNumber !== this.o.accountId) return;
    if (contract.secType !== 'STK') return;
    const side = e.side === 'BOT' || e.side === 'BUY' ? 'BUY' : e.side === 'SLD' || e.side === 'SELL' ? 'SELL' : null;
    if (!side || typeof e.shares !== 'number' || typeof e.price !== 'number' || !e.time) return;
    this.execs.set(e.execId, { execId: e.execId, orderRef: e.orderRef ?? '', symbol: contract.symbol ?? '', side, shares: e.shares, price: e.price, atMs: parseExecTime(e.time, this.tz) });
  }

  // ---- account ------------------------------------------------------------
  private own(id: string): void { if (id !== this.o.accountId) throw new OrderRefused('WRONG_ACCOUNT', id); }
  private needConnected(): void { if (!this.connected) throw new Error('IB_NOT_CONNECTED'); }

  async account(id: string): Promise<BrokerAccount> {
    this.own(id); this.needConnected();
    return this.requests.run(async () => {
      const req = ++this.reqSeq;
      this.summary = [];
      this.client.reqAccountSummary(req, 'TotalCashValue');
      const ok = await this.until(() => this.summaryDone.has(req), this.reqMs);
      this.client.cancelAccountSummary(req);
      if (!ok) throw new Error('IB_ACCOUNT_TIMEOUT');
      const rows = this.summary.filter((r) => r.tag === 'TotalCashValue');
      const usd = rows.filter((r) => r.currency === 'USD');
      if (usd.length !== 1) throw new Error(`IB_CASH_NOT_USD: ${rows.map((r) => r.currency).join(',') || 'none'}`);
      const cash = toMinor(usd[0]!.value);
      return { id, mode: 'BROKER_PAPER' as const, currency: 'USD', cashMinor: cash.toString() };
    });
  }

  async positions(id: string): Promise<BrokerPosition[]> {
    this.own(id); this.needConnected();
    return this.requests.run(async () => {
      this.posRows = []; this.posDone = false;
      this.client.reqPositions();
      const ok = await this.until(() => this.posDone, this.reqMs);
      this.client.cancelPositions();
      if (!ok) throw new Error('IB_POSITIONS_TIMEOUT');
      const agg = new Map<string, { q: bigint; cost: bigint }>();
      for (const r of this.posRows) {
        if (r.pos === 0) continue;
        if (r.contract.secType !== 'STK' || r.contract.currency !== 'USD') throw new Error(`IB_UNSUPPORTED_HOLDING: ${r.contract.symbol} ${r.contract.secType} ${r.contract.currency}`);
        if (r.pos < 0) throw new Error(`IB_SHORT_POSITION: ${r.contract.symbol}`);
        const q = wholeShares(r.pos, 'position');
        const a = agg.get(r.contract.symbol ?? '') ?? { q: 0n, cost: 0n };
        a.q += q; a.cost += toMinor(r.avgCost * r.pos);
        agg.set(r.contract.symbol ?? '', a);
      }
      return [...agg].map(([instrumentId, a]) => ({ instrumentId, quantity: a.q.toString(), costMinor: a.cost.toString() }));
    });
  }

  // ---- data refresh -------------------------------------------------------
  private refreshOrders(): Promise<void> {
    return this.requests.run(async () => {
      this.needConnected();
      this.openDone = false; this.completedDone = false;
      this.client.reqAllOpenOrders();
      this.client.reqCompletedOrders(true);
      const ok = await this.until(() => this.openDone && this.completedDone, this.reqMs);
      if (!ok) throw new Error('IB_ORDERS_TIMEOUT');
    });
  }
  private refreshExecutions(): Promise<void> {
    return this.requests.run(async () => {
      this.needConnected();
      const req = ++this.reqSeq;
      this.client.reqExecutions(req, this.o.accountId);
      const ok = await this.until(() => this.execDone.has(req), this.reqMs);
      if (!ok) throw new Error('IB_EXECUTIONS_TIMEOUT');
    });
  }

  // ---- placing ------------------------------------------------------------
  async place(i: OrderIntent): Promise<BrokerOrder> {
    validateIntent(i);
    this.own(i.accountId);
    if (i.clientOrderId.length > 100) throw new OrderRefused('CLIENT_ORDER_ID_TOO_LONG');
    if (i.clientOrderId.includes('#')) throw new OrderRefused('CLIENT_ORDER_ID_RESERVED_CHAR');
    // already sent in this session: the same answer as before, never a second order
    const known = [...this.orders.values()].find((r) => r.orderRef === i.clientOrderId && r.orderId > 0);
    if (known) return (await this.snapshot(i.clientOrderId))!;
    if (!this.connected) throw new OrderRefused('IB_NOT_CONNECTED');
    if (!this.linkUp) throw new OrderRefused('IB_LINK_DOWN');
    return i.kind === 'BUY_BRACKET' ? this.placeBracket(i) : this.placeClose(i);
  }

  private contract(symbol: string): IbContract { return { symbol, secType: 'STK', exchange: 'SMART', currency: 'USD' }; }

  private async placeBracket(i: BuyBracketIntent): Promise<BrokerOrder> {
    const qty = Number(integer(i.quantity, true));
    const parent = this.nextId, stop = this.nextId + 1, target = this.nextId + 2;
    this.nextId += 3;
    const cid = i.clientOrderId;
    const common = { account: this.o.accountId, totalQuantity: qty };
    // children are one OCA group: when one exits the position the other is cancelled by IB, never both sold
    const oca = { ocaGroup: cid, ocaType: 1, parentId: parent };
    const orders: Array<[number, IbOrder]> = [
      [parent, { ...common, orderId: parent, action: 'BUY', orderType: 'LMT', lmtPrice: fromMinor(i.entryLimitMinor), tif: 'DAY', outsideRth: false, orderRef: cid, transmit: false }],
      [stop, { ...common, ...oca, orderId: stop, action: 'SELL', orderType: 'STP', auxPrice: fromMinor(i.stopMinor), tif: 'GTC', outsideRth: false, orderRef: cid + STOP_SUFFIX, transmit: false }],
      [target, { ...common, ...oca, orderId: target, action: 'SELL', orderType: 'LMT', lmtPrice: fromMinor(i.targetMinor), tif: 'GTC', outsideRth: false, orderRef: cid + TARGET_SUFFIX, transmit: true }],
    ];
    // remember what we are about to send BEFORE sending, so a lookup during the send sees it
    for (const [id, o] of orders) this.orders.set(id, { orderId: id, orderRef: o.orderRef!, symbol: i.instrumentId, action: o.action!, type: o.orderType!, qty, parentId: o.parentId ?? 0, oca: o.ocaGroup ?? '', status: 'ApiPending', filled: 0, avg: 0 });
    for (const id of [parent, stop, target]) this.orderErrors.delete(id);

    let sent = 0;
    try {
      for (const [id, o] of orders) { this.client.placeOrder(id, this.contract(i.instrumentId), o); sent++; }
    } catch (e) {
      if (sent < 3) {
        // the last order carries transmit=true; before it nothing is live. Drop what is staged and say it was not sent.
        for (const [id] of orders.slice(0, sent)) { try { this.client.cancelOrder(id); } catch { /* staged only */ } }
        if (sent < 2) throw new OrderRefused('IB_SEND_FAILED', (e as Error).message);
      }
      throw new Error(`IB_SEND_UNCERTAIN: ${(e as Error).message}`);
    }
    return this.confirmAck([parent, stop, target], parent, cid, i.instrumentId);
  }

  private async placeClose(i: CloseIntent): Promise<BrokerOrder> {
    await this.refreshOrders();
    const pos = (await this.positions(i.accountId)).find((p) => p.instrumentId === i.instrumentId);
    const held = pos ? integer(pos.quantity) : 0n;
    if (held < integer(i.quantity)) throw new OrderRefused('NO_POSITION_TO_CLOSE');
    // A partial close would need the surviving shares re-protected, which OCA does not do: only whole-position closes.
    if (held > integer(i.quantity)) throw new OrderRefused('PARTIAL_CLOSE_UNSUPPORTED', `${held} held`);

    const sells = [...this.orders.values()].filter((r) => r.symbol === i.instrumentId && r.action === 'SELL' && WORKING.has(r.status));
    const groups = new Set(sells.map((r) => r.oca).filter(Boolean));
    if (sells.some((r) => !r.oca)) throw new OrderRefused('UNKNOWN_SELL_ORDERS_OPEN');
    if (groups.size > 1) throw new OrderRefused('AMBIGUOUS_PROTECTION');
    const group = [...groups][0];

    const id = this.nextId++;
    // Joining the bracket's OCA group means: if the stop or target fills first the close is cancelled, and if the
    // close fills first the stop and target are cancelled. No unprotected moment, no double sale.
    const order: IbOrder = {
      orderId: id, account: this.o.accountId, action: 'SELL', orderType: 'MKT', totalQuantity: Number(integer(i.quantity, true)), tif: 'DAY',
      outsideRth: false, orderRef: i.clientOrderId, transmit: true, ...(group ? { ocaGroup: group, ocaType: 1 } : {}),
    };
    this.orders.set(id, { orderId: id, orderRef: i.clientOrderId, symbol: i.instrumentId, action: 'SELL', type: 'MKT', qty: order.totalQuantity!, parentId: 0, oca: group ?? '', status: 'ApiPending', filled: 0, avg: 0 });
    this.orderErrors.delete(id);
    try {
      this.client.placeOrder(id, this.contract(i.instrumentId), order);
    } catch (e) {
      throw new Error(`IB_SEND_UNCERTAIN: ${(e as Error).message}`);
    }
    return this.confirmAck([id], id, i.clientOrderId, i.instrumentId);
  }

  /**
   * Waits until TWS has acknowledged every order of a placement. Three outcomes:
   *  - acknowledged: return the order as IB now reports it;
   *  - definitely refused (a known reject code, or status Inactive) and nothing is live: OrderRefused;
   *  - anything else (silence, unknown error code, something filled): an ordinary Error = UNCERTAIN, so the caller looks it up.
   */
  private async confirmAck(ids: number[], mainId: number, cid: string, symbol: string): Promise<BrokerOrder> {
    const state = () => ids.map((id) => this.orders.get(id)!);
    const refusedId = () => ids.find((id) => { const e = this.orderErrors.get(id); return (e && DEFINITE_REJECT.has(e.code)) || this.orders.get(id)?.status === 'Inactive'; });
    const settled = () => refusedId() !== undefined || state().every((r) => r.status !== 'ApiPending' && r.status !== 'PendingSubmit');
    const answered = await this.until(settled, this.ackMs);
    const bad = refusedId();
    if (bad !== undefined) {
      const err = this.orderErrors.get(bad);
      // make sure the rest of the bracket cannot go live on its own
      for (const id of ids) { const r = this.orders.get(id)!; if (id !== bad && !DEAD.has(r.status) && r.status !== 'Filled') { try { this.client.cancelOrder(id); } catch { /* ignore */ } } }
      const mainDead = await this.until(() => { const r = this.orders.get(mainId)!; return DEAD.has(r.status); }, this.ackMs);
      const main = this.orders.get(mainId)!;
      if (mainDead && main.filled === 0) throw new OrderRefused(`IB_${err?.code ?? 'REJECTED'}`, err?.message ?? 'rejected');
      throw new Error(`IB_PARTIAL_REJECT_UNRESOLVED: code ${err?.code ?? '?'}`);
    }
    if (!answered) throw new Error('IB_ACK_TIMEOUT');
    const snap = await this.snapshot(cid, symbol);
    if (!snap) throw new Error('IB_ORDER_NOT_VISIBLE_AFTER_ACK');
    return snap;
  }

  // ---- lookup -------------------------------------------------------------
  async getOrder(accountId: string, clientOrderId: string): Promise<BrokerOrder | null> {
    this.own(accountId);
    await this.refreshOrders();
    await this.refreshExecutions();
    return this.snapshot(clientOrderId);
  }

  private byRef(ref: string, action?: string): OrderRec | undefined {
    return [...this.orders.values()].find((r) => r.orderRef === ref && (!action || r.action === action));
  }
  private fillOf(ref: string): { qty: bigint; cents: bigint } {
    let q = 0n, cents = 0n;
    for (const e of this.execs.values()) if (e.orderRef === ref) { const s = wholeShares(e.shares, 'execution'); q += s; cents += s * toMinor(e.price); }
    const rec = [...this.orders.values()].find((r) => r.orderRef === ref);
    if (rec && rec.filled > 0 && BigInt(Math.round(rec.filled)) > q) {
      // orderStatus knows more than the executions seen so far (they can arrive later): trust the larger count
      q = wholeShares(Math.round(rec.filled), 'fill'); cents = q * toMinor(rec.avg);
    }
    return { qty: q, cents };
  }
  private avg(f: { qty: bigint; cents: bigint }): string | null { return f.qty === 0n ? null : ((f.cents + f.qty / 2n) / f.qty).toString(); }

  /** The order as IB currently reports it, from what this process has been told. null: IB has never mentioned this id. */
  private async snapshot(cid: string, _symbol?: string): Promise<BrokerOrder | null> {
    const parent = this.byRef(cid, 'BUY');
    if (parent) return this.bracketView(cid, parent);
    const close = this.byRef(cid, 'SELL');
    if (close) return this.closeView(cid, close);
    return null;
  }

  private mapStatus(rec: OrderRec, filled: bigint): BrokerOrderStatus {
    if (!KNOWN.has(rec.status)) throw new Error(`IB_UNKNOWN_STATUS: ${rec.status}`);
    const total = BigInt(Math.round(rec.qty));
    if (filled >= total && total > 0n) return 'FILLED';
    if (rec.status === 'Inactive') return filled > 0n ? 'PART_FILLED' : 'REJECTED';
    if (rec.status === 'Cancelled' || rec.status === 'ApiCancelled') return 'CANCELED';
    if (rec.status === 'Filled') return 'FILLED';
    return filled > 0n ? 'PART_FILLED' : 'ACCEPTED';
  }

  private bracketView(cid: string, parent: OrderRec): BrokerOrder {
    const entry = this.fillOf(cid);
    const stopRec = this.byRef(cid + STOP_SUFFIX);
    const stopFill = this.fillOf(cid + STOP_SUFFIX), tgtFill = this.fillOf(cid + TARGET_SUFFIX);
    // a close placed into this bracket's OCA group counts as the bracket's exit, with reason CLOSE
    const closes = [...this.orders.values()].filter((r) => r.action === 'SELL' && r.oca === cid && !r.orderRef.endsWith(STOP_SUFFIX) && !r.orderRef.endsWith(TARGET_SUFFIX));
    const closeFill = closes.reduce((s, r) => s + this.fillOf(r.orderRef).qty, 0n);
    const exited = stopFill.qty + tgtFill.qty + closeFill;
    const remaining = entry.qty > exited ? entry.qty - exited : 0n;
    const protectedQty = stopRec && LIVE_AT_EXCHANGE.has(stopRec.status) ? remaining : 0n;
    let reason: ExitReason | null = null;
    if (exited > 0n && remaining === 0n) reason = closeFill > 0n ? 'CLOSE' : tgtFill.qty > 0n ? 'TARGET' : 'STOP';
    const status = this.mapStatus(parent, entry.qty);
    return {
      accountId: this.o.accountId, clientOrderId: cid, brokerOrderId: String(parent.orderId), status,
      filledQuantity: entry.qty.toString(), averageFillMinor: this.avg(entry), protectedQuantity: protectedQty.toString(),
      exitedQuantity: exited.toString(), exitReason: reason,
    };
  }

  private closeView(cid: string, close: OrderRec): BrokerOrder {
    const f = this.fillOf(cid);
    return {
      accountId: this.o.accountId, clientOrderId: cid, brokerOrderId: String(close.orderId), status: this.mapStatus(close, f.qty),
      filledQuantity: f.qty.toString(), averageFillMinor: this.avg(f), protectedQuantity: '0', exitedQuantity: '0', exitReason: null,
    };
  }

  /** What this process currently knows of IB's orders, for the paper verification script and for operators. */
  describeOrders(): Array<{ orderId: number; orderRef: string; symbol: string; action: string; type: string; status: string; parentId: number; oca: string; filled: number }> {
    return [...this.orders.values()].map((r) => ({ orderId: r.orderId, orderRef: r.orderRef, symbol: r.symbol, action: r.action, type: r.type, status: r.status, parentId: r.parentId, oca: r.oca, filled: r.filled }));
  }
  /** Re-reads open and completed orders from IB. */
  async refreshAll(): Promise<void> { await this.refreshOrders(); await this.refreshExecutions(); }

  // ---- cancel -------------------------------------------------------------
  async cancel(accountId: string, clientOrderId: string): Promise<BrokerOrder> {
    this.own(accountId);
    this.needConnected();
    await this.refreshOrders();
    const rec = this.byRef(clientOrderId, 'BUY') ?? this.byRef(clientOrderId, 'SELL');
    if (!rec) throw new Error('ORDER_NOT_FOUND');
    if (WORKING.has(rec.status)) {
      // Only the order itself. Shares an entry already bought keep the stop and target IB attached to them
      // (to be confirmed on paper for partial fills).
      this.client.cancelOrder(rec.orderId);
      const ok = await this.until(() => !WORKING.has(this.orders.get(rec.orderId)!.status), this.ackMs);
      if (!ok) throw new Error('IB_CANCEL_UNCONFIRMED');
    }
    await this.refreshExecutions();
    return (await this.snapshot(clientOrderId))!;
  }

  // ---- executions ---------------------------------------------------------
  /**
   * Today's executions of this account with their real commissions. An execution whose commission report has not
   * arrived is not reported with a made-up zero fee: the call fails (COMMISSION_PENDING) and the caller retries,
   * because cash already reflects the fee and a missing fee would look like missing money.
   */
  async executions(accountId: string, sinceMs: number): Promise<Execution[]> {
    this.own(accountId);
    await this.refreshExecutions();
    const wanted = [...this.execs.values()].filter((e) => e.atMs >= sinceMs);
    const have = () => wanted.every((e) => this.commissions.has(e.execId));
    if (!(await this.until(have, this.commMs))) {
      throw new Error(`COMMISSION_PENDING: ${wanted.filter((e) => !this.commissions.has(e.execId)).length} execution(s)`);
    }
    return wanted.map((e) => {
      const fee = this.commissions.get(e.execId)!;
      if (fee.currency !== 'USD') throw new Error(`IB_FEE_NOT_USD: ${fee.currency}`);
      const base = e.orderRef.endsWith(STOP_SUFFIX) ? e.orderRef.slice(0, -STOP_SUFFIX.length) : e.orderRef.endsWith(TARGET_SUFFIX) ? e.orderRef.slice(0, -TARGET_SUFFIX.length) : e.orderRef;
      return {
        executionId: e.execId, clientOrderId: base || null, instrumentId: e.symbol, side: e.side,
        quantity: wholeShares(e.shares, 'execution').toString(), priceMinor: toMinor(e.price).toString(),
        feeMinor: toMinor(fee.commission, 'ceil').toString(), atMs: e.atMs,
      };
    });
  }
}
