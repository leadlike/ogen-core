import { EventEmitter } from 'node:events';
import { IBApi, EventName, SecType, OrderAction, OrderType, TimeInForce, type Contract, type Order } from '@stoqey/ib';

/**
 * The narrow slice of the TWS API that the adapter uses. Everything the adapter knows about Interactive
 * Brokers goes through this interface, so the adapter can be driven by a scripted fake in tests and by the
 * real socket client in production without changing its logic.
 */
export interface IbContract { symbol?: string; secType?: string; currency?: string; exchange?: string; conId?: number }
export interface IbOrder {
  orderId?: number; action?: string; orderType?: string; totalQuantity?: number; lmtPrice?: number; auxPrice?: number;
  parentId?: number; ocaGroup?: string; ocaType?: number; orderRef?: string; tif?: string; outsideRth?: boolean;
  transmit?: boolean; account?: string; filledQuantity?: number;
}
export interface IbOrderState { status?: string }
export interface IbExecution {
  orderId?: number; execId?: string; time?: string; acctNumber?: string; side?: string; shares?: number; price?: number;
  orderRef?: string; permId?: number;
}
export interface IbCommission { execId?: string; commission?: number; currency?: string }

/** Events the adapter listens to; payloads follow the TWS API callbacks. */
export interface IbEventMap {
  connected: [];
  disconnected: [];
  nextValidId: [orderId: number];
  managedAccounts: [accounts: string];
  error: [error: Error, code: number, reqId: number];
  openOrder: [orderId: number, contract: IbContract, order: IbOrder, state: IbOrderState];
  openOrderEnd: [];
  completedOrder: [contract: IbContract, order: IbOrder, state: IbOrderState];
  completedOrdersEnd: [];
  orderStatus: [orderId: number, status: string, filled: number, remaining: number, avgFillPrice: number, permId?: number, parentId?: number];
  execDetails: [reqId: number, contract: IbContract, execution: IbExecution];
  execDetailsEnd: [reqId: number];
  commissionReport: [report: IbCommission];
  position: [account: string, contract: IbContract, pos: number, avgCost?: number];
  positionEnd: [];
  accountSummary: [reqId: number, account: string, tag: string, value: string, currency: string];
  accountSummaryEnd: [reqId: number];
  tickPrice: [reqId: number, field: number, value: number];
  tickSize: [reqId: number, field: number, value: number];
}
export type IbEventName = keyof IbEventMap;

export interface IbClient {
  readonly isConnected: boolean;
  connect(): void;
  disconnect(): void;
  on<E extends IbEventName>(event: E, listener: (...args: IbEventMap[E]) => void): void;
  off<E extends IbEventName>(event: E, listener: (...args: IbEventMap[E]) => void): void;
  placeOrder(orderId: number, contract: IbContract, order: IbOrder): void;
  cancelOrder(orderId: number): void;
  reqIds(): void;
  reqAllOpenOrders(): void;
  reqCompletedOrders(apiOnly: boolean): void;
  /** all of today's executions of this account (no time filter: the adapter filters by time itself) */
  reqExecutions(reqId: number, account: string): void;
  reqPositions(): void;
  cancelPositions(): void;
  reqAccountSummary(reqId: number, tags: string): void;
  cancelAccountSummary(reqId: number): void;
  /** real-time data only: the adapter never asks for delayed or frozen data */
  reqRealTimeMarketData(): void;
  reqMktData(reqId: number, contract: IbContract): void;
  cancelMktData(reqId: number): void;
}

const SEC: Record<string, SecType> = { STK: SecType.STK };
const ACTION: Record<string, OrderAction> = { BUY: OrderAction.BUY, SELL: OrderAction.SELL };
const TYPE: Record<string, OrderType> = { LMT: OrderType.LMT, STP: OrderType.STP, MKT: OrderType.MKT };
const TIF: Record<string, TimeInForce> = { DAY: TimeInForce.DAY, GTC: TimeInForce.GTC };

/** Production client: @stoqey/ib over the TWS socket (IB Gateway). */
export class StoqeyClient implements IbClient {
  private api: IBApi;
  private bus = new EventEmitter();
  constructor(private host: string, private port: number, private clientId: number) {
    this.api = new IBApi({ host, port });
    this.bus.setMaxListeners(50);
    // forward every event the adapter cares about
    const names: IbEventName[] = ['connected', 'disconnected', 'nextValidId', 'managedAccounts', 'error', 'openOrder', 'openOrderEnd', 'completedOrder', 'completedOrdersEnd', 'orderStatus', 'execDetails', 'execDetailsEnd', 'commissionReport', 'position', 'positionEnd', 'accountSummary', 'accountSummaryEnd', 'tickPrice', 'tickSize'];
    for (const n of names) (this.api as unknown as EventEmitter).on(EventName[n as keyof typeof EventName], (...a: unknown[]) => this.bus.emit(n, ...a));
  }
  get isConnected(): boolean { return this.api.isConnected; }
  connect(): void { this.api.connect(this.clientId); }
  disconnect(): void { this.api.disconnect(); }
  on<E extends IbEventName>(event: E, l: (...a: IbEventMap[E]) => void): void { this.bus.on(event, l as (...a: unknown[]) => void); }
  off<E extends IbEventName>(event: E, l: (...a: IbEventMap[E]) => void): void { this.bus.off(event, l as (...a: unknown[]) => void); }

  private contract(c: IbContract): Contract {
    const secType = SEC[c.secType ?? ''];
    if (!secType) throw new Error('UNSUPPORTED_SEC_TYPE');
    return { symbol: c.symbol, secType, exchange: c.exchange ?? 'SMART', currency: c.currency ?? 'USD' };
  }
  placeOrder(id: number, contract: IbContract, o: IbOrder): void {
    const action = ACTION[o.action ?? ''], orderType = TYPE[o.orderType ?? ''], tif = TIF[o.tif ?? ''];
    if (!action || !orderType || !tif) throw new Error('UNSUPPORTED_ORDER');
    const order: Order = { action, orderType, tif, totalQuantity: o.totalQuantity, lmtPrice: o.lmtPrice, auxPrice: o.auxPrice, parentId: o.parentId, ocaGroup: o.ocaGroup, ocaType: o.ocaType, orderRef: o.orderRef, outsideRth: o.outsideRth, transmit: o.transmit, account: o.account };
    this.api.placeOrder(id, this.contract(contract), order);
  }
  cancelOrder(id: number): void { this.api.cancelOrder(id); }
  reqIds(): void { this.api.reqIds(1); }
  reqAllOpenOrders(): void { this.api.reqAllOpenOrders(); }
  reqCompletedOrders(apiOnly: boolean): void { this.api.reqCompletedOrders(apiOnly); }
  reqExecutions(reqId: number, account: string): void { this.api.reqExecutions(reqId, { acctCode: account } as never); }
  reqPositions(): void { this.api.reqPositions(); }
  cancelPositions(): void { this.api.cancelPositions(); }
  reqAccountSummary(reqId: number, tags: string): void { this.api.reqAccountSummary(reqId, 'All', tags); }
  cancelAccountSummary(reqId: number): void { this.api.cancelAccountSummary(reqId); }
  reqRealTimeMarketData(): void { this.api.reqMarketDataType(1 as never); }
  reqMktData(reqId: number, c: IbContract): void { this.api.reqMktData(reqId, this.contract(c), '', false, false); }
  cancelMktData(reqId: number): void { this.api.cancelMktData(reqId); }
}
