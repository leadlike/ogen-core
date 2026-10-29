/**
 * BROKER_PAPER order model. Whole shares, one currency per account, prices and cash in integer
 * minor units (cents for USD) carried as decimal strings and handled as bigint.
 * This module never talks to a real-money account: mode is the literal 'BROKER_PAPER'.
 */
export type BrokerMode = 'BROKER_PAPER';
export type OrderStatus = 'SUBMITTING' | 'UNKNOWN' | 'ACCEPTED' | 'PART_FILLED' | 'FILLED' | 'CANCELED' | 'REJECTED';
export type BrokerOrderStatus = Exclude<OrderStatus, 'SUBMITTING' | 'UNKNOWN'>;

interface IntentBase {
  mode: BrokerMode;
  accountId: string;
  clientOrderId: string;
  instrumentId: string;
  currency: string;
  quantity: string;
}
/** Entry with a stop and a target held BY THE BROKER (still active if our process dies). */
export interface BuyBracketIntent extends IntentBase {
  kind: 'BUY_BRACKET';
  entryLimitMinor: string;
  stopMinor: string;
  targetMinor: string;
}
/** Sells shares we already hold. No stop is attached; the broker cancels the protection it replaces. */
export interface CloseIntent extends IntentBase {
  kind: 'CLOSE';
}
export type OrderIntent = BuyBracketIntent | CloseIntent;

export type ExitReason = 'STOP' | 'TARGET' | 'CLOSE';
export interface BrokerOrder {
  accountId: string;
  clientOrderId: string;
  brokerOrderId: string;
  status: BrokerOrderStatus;
  filledQuantity: string;
  /** average fill price of this order (entry price for a bracket, sale price for a close) */
  averageFillMinor: string | null;
  /** shares of this order currently covered by a broker-side stop/target */
  protectedQuantity: string;
  /** shares of a bracket already sold by its stop or target, or by a close */
  exitedQuantity: string;
  exitReason: ExitReason | null;
}
export interface BrokerAccount { id: string; mode: BrokerMode; currency: string; cashMinor: string }
export interface BrokerPosition { instrumentId: string; quantity: string; costMinor: string }

/** One fill as the broker reports it. The audit trail the broker's own account is checked against. */
export interface Execution {
  executionId: string;
  /** null when the order was not placed through our client order ids (e.g. a manual trade in the account) */
  clientOrderId: string | null;
  instrumentId: string;
  side: 'BUY' | 'SELL';
  quantity: string;
  priceMinor: string;
  feeMinor: string;
  atMs: number;
}

export interface BrokerCapabilities {
  paper: boolean;
  atomicBracket: boolean;
  partialFillProtection: boolean;
  lookupByClientId: boolean;
}
export interface Broker {
  capabilities: BrokerCapabilities;
  account(accountId: string): Promise<BrokerAccount>;
  positions(accountId: string): Promise<BrokerPosition[]>;
  place(intent: OrderIntent): Promise<BrokerOrder>;
  getOrder(accountId: string, clientOrderId: string): Promise<BrokerOrder | null>;
  cancel(accountId: string, clientOrderId: string): Promise<BrokerOrder>;
  /** Fills with atMs >= sinceMs. May overlap earlier calls: callers de-duplicate by executionId. */
  executions(accountId: string, sinceMs: number): Promise<Execution[]>;
}

/**
 * Thrown by a risk layer when it DEFINITELY did not send the order. Unlike a timeout, this is a
 * known outcome, so the executor records it as REJECTED instead of leaving it UNKNOWN.
 */
export class OrderRefused extends Error {
  constructor(public readonly code: string, detail = '') {
    super(`ORDER_REFUSED: ${code}${detail ? ` (${detail})` : ''}`);
    this.name = 'OrderRefused';
  }
}

export interface IntentRecord {
  intent: OrderIntent;
  fingerprint: string;
  status: OrderStatus;
  order: BrokerOrder | null;
  /** milliseconds since the status last changed, measured by the store's own clock */
  ageMs: number;
}
export interface IntentStore {
  ensureAccount(accountId: string, currency: string): Promise<void>;
  /** Atomically inserts the intent as SUBMITTING, or returns the existing row. Committed BEFORE any broker call. */
  claim(intent: OrderIntent, fingerprint: string): Promise<{ created: boolean; record: IntentRecord }>;
  /** Guarded by assertTransition; throws ILLEGAL_TRANSITION instead of overwriting a newer state. */
  save(intent: OrderIntent, status: OrderStatus, order: BrokerOrder | null): Promise<void>;
  /** SUBMITTING -> UNKNOWN only. Any other current state is left untouched. */
  markUnknown(intent: OrderIntent): Promise<void>;
}

export function integer(value: string, positive = false): bigint {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) throw new Error('INVALID_INTEGER');
  const result = BigInt(value);
  if (positive && result === 0n) throw new Error('POSITIVE_INTEGER_REQUIRED');
  return result;
}

export function validateIntent(i: OrderIntent): void {
  if (i.mode !== 'BROKER_PAPER') throw new Error('PAPER_ONLY');
  if (i.kind !== 'BUY_BRACKET' && i.kind !== 'CLOSE') throw new Error('INVALID_KIND');
  for (const id of [i.accountId, i.clientOrderId, i.instrumentId]) {
    if (typeof id !== 'string' || !id.trim() || id.length > 128) throw new Error('INVALID_IDENTIFIER');
  }
  if (!/^[A-Z]{3}$/.test(i.currency)) throw new Error('INVALID_CURRENCY');
  integer(i.quantity, true);
  if (i.kind === 'BUY_BRACKET') {
    const entry = integer(i.entryLimitMinor, true);
    const stop = integer(i.stopMinor, true);
    const target = integer(i.targetMinor, true);
    if (!(stop < entry && entry < target)) throw new Error('INVALID_BRACKET_PRICES');
  }
}

const BROKER_STATUSES: readonly OrderStatus[] = ['ACCEPTED', 'PART_FILLED', 'FILLED', 'CANCELED', 'REJECTED'];
const NEXT: Record<OrderStatus, readonly OrderStatus[]> = {
  SUBMITTING: ['UNKNOWN', ...BROKER_STATUSES],
  UNKNOWN: ['UNKNOWN', ...BROKER_STATUSES],
  ACCEPTED: ['ACCEPTED', 'PART_FILLED', 'FILLED', 'CANCELED', 'REJECTED'],
  PART_FILLED: ['PART_FILLED', 'FILLED', 'CANCELED'],
  FILLED: ['FILLED'],
  CANCELED: ['CANCELED'],
  REJECTED: ['REJECTED'],
};

/** Pure rule shared by every store: legal status moves, and fills/exits can never go backwards. */
export function assertTransition(from: OrderStatus, to: OrderStatus, prior: BrokerOrder | null, next: BrokerOrder | null): void {
  if (!NEXT[from].includes(to)) throw new Error(`ILLEGAL_TRANSITION: ${from} -> ${to}`);
  if (prior && next) {
    if (integer(next.filledQuantity) < integer(prior.filledQuantity)) throw new Error('ILLEGAL_TRANSITION: filled quantity decreased');
    if (integer(next.exitedQuantity) < integer(prior.exitedQuantity)) throw new Error('ILLEGAL_TRANSITION: exited quantity decreased');
  }
  if (prior && !next) throw new Error('ILLEGAL_TRANSITION: broker state would be erased');
}
