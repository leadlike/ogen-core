import { integer, validateIntent, type Broker, type BrokerOrder, type BrokerPosition, type BuyBracketIntent, type Execution, type OrderIntent } from './types';

export type FakeScenario = 'ACCEPT' | 'REJECT' | 'PARTIAL' | 'TIMEOUT_AFTER_ACCEPT' | 'TIMEOUT_BEFORE_ACCEPT';

interface Row { intent: OrderIntent; order: BrokerOrder }

/**
 * DETERMINISTIC TEST DOUBLE. It is not a market and not a broker: nothing fills unless a test calls
 * fill() or tick(). It must never be wired into a phase that claims to use real prices.
 * Bracket protection is evaluated in tick(), independently of any worker process, which is the
 * property a real broker-side stop provides.
 */
export class FakeBroker implements Broker {
  capabilities = { paper: true, atomicBracket: true, partialFillProtection: true, lookupByClientId: true };
  placeCalls = 0;
  scenario: FakeScenario = 'ACCEPT';
  private rows = new Map<string, Row>();
  private marks = new Map<string, bigint>();
  private cash: bigint;
  private execs: Execution[] = [];
  private externals = new Map<string, bigint>();
  /** commission charged on every execution, in minor units. Default 0. */
  feeMinor = 0n;
  /** clock used to stamp executions; tests may replace it */
  nowMs: () => number = Date.now;

  constructor(private accountId = 'test-paper', private currency = 'USD', initialCashMinor = 50_000n) {
    this.cash = initialCashMinor;
  }

  private key(account: string, id: string): string { return JSON.stringify([account, id]); }
  private brackets(): Array<{ intent: BuyBracketIntent; order: BrokerOrder }> {
    return [...this.rows.values()].filter((r): r is { intent: BuyBracketIntent; order: BrokerOrder } => r.intent.kind === 'BUY_BRACKET');
  }
  private remaining(o: BrokerOrder): bigint { return integer(o.filledQuantity) - integer(o.exitedQuantity); }

  async account(id: string) {
    if (id !== this.accountId) throw new Error('ACCOUNT_NOT_FOUND');
    return { id, mode: 'BROKER_PAPER' as const, currency: this.currency, cashMinor: this.cash.toString() };
  }

  async positions(id: string): Promise<BrokerPosition[]> {
    await this.account(id);
    const agg = new Map<string, { quantity: bigint; cost: bigint }>();
    for (const { intent, order } of this.brackets()) {
      const rem = this.remaining(order);
      const p = agg.get(intent.instrumentId) ?? { quantity: 0n, cost: 0n };
      p.quantity += rem;
      p.cost += rem * BigInt(order.averageFillMinor ?? '0');
      agg.set(intent.instrumentId, p);
    }
    for (const [inst, qty] of this.externals) {
      const p = agg.get(inst) ?? { quantity: 0n, cost: 0n };
      p.quantity += qty;
      agg.set(inst, p);
    }
    return [...agg].filter(([, p]) => p.quantity > 0n).map(([instrumentId, p]) => ({ instrumentId, quantity: p.quantity.toString(), costMinor: p.cost.toString() }));
  }

  private blank(i: OrderIntent, status: BrokerOrder['status']): BrokerOrder {
    return {
      accountId: i.accountId, clientOrderId: i.clientOrderId, brokerOrderId: `fake-${this.placeCalls}`, status,
      filledQuantity: '0', averageFillMinor: null, protectedQuantity: '0', exitedQuantity: '0', exitReason: null,
    };
  }

  async place(i: OrderIntent): Promise<BrokerOrder> {
    validateIntent(i);
    await this.account(i.accountId);
    this.placeCalls++;
    const k = this.key(i.accountId, i.clientOrderId);
    const existing = this.rows.get(k);
    if (existing) return structuredClone(existing.order);
    if (this.scenario === 'TIMEOUT_BEFORE_ACCEPT') throw new Error('SIMULATED_TIMEOUT');

    if (i.kind === 'CLOSE') {
      const order = this.close(i);
      this.rows.set(k, { intent: structuredClone(i), order });
      if (this.scenario === 'TIMEOUT_AFTER_ACCEPT') throw new Error('SIMULATED_TIMEOUT');
      return structuredClone(order);
    }

    const order = this.blank(i, this.scenario === 'REJECT' ? 'REJECTED' : 'ACCEPTED');
    this.rows.set(k, { intent: structuredClone(i), order });
    if (this.scenario === 'PARTIAL') this.fill(i.clientOrderId, '1', i.entryLimitMinor);
    if (this.scenario === 'TIMEOUT_AFTER_ACCEPT') throw new Error('SIMULATED_TIMEOUT');
    return structuredClone(order);
  }

  /** Sells held shares at the last mark. No mark or not enough shares: rejected (never a short). */
  private close(i: OrderIntent): BrokerOrder {
    const qty = integer(i.quantity, true);
    const mark = this.marks.get(i.instrumentId);
    const held = this.brackets().filter((b) => b.intent.instrumentId === i.instrumentId).reduce((s, b) => s + this.remaining(b.order), 0n);
    if (mark === undefined || held < qty) return this.blank(i, 'REJECTED');
    let left = qty;
    for (const b of this.brackets()) {
      if (b.intent.instrumentId !== i.instrumentId || left === 0n) continue;
      const take = this.remaining(b.order) < left ? this.remaining(b.order) : left;
      if (take === 0n) continue;
      this.exit(b.order, take, mark, 'CLOSE', i.instrumentId, i.clientOrderId);
      left -= take;
    }
    const order = this.blank(i, 'FILLED');
    order.filledQuantity = qty.toString();
    order.averageFillMinor = mark.toString();
    return order;
  }

  /** Removes `qty` shares from a bracket (its protection goes with them) and credits the cash. */
  private exit(o: BrokerOrder, qty: bigint, price: bigint, reason: 'STOP' | 'TARGET' | 'CLOSE', instrumentId: string, execOrderId: string): void {
    o.exitedQuantity = (integer(o.exitedQuantity) + qty).toString();
    o.protectedQuantity = this.remaining(o).toString();
    if (this.remaining(o) === 0n) o.exitReason = reason;
    this.cash += qty * price - this.feeMinor;
    this.record(execOrderId, instrumentId, 'SELL', qty, price);
    // the part of the entry that has not filled yet must not buy back into an exited trade
    if (this.remaining(o) === 0n && (o.status === 'ACCEPTED' || o.status === 'PART_FILLED')) o.status = 'CANCELED';
  }

  private record(clientOrderId: string | null, instrumentId: string, side: 'BUY' | 'SELL', qty: bigint, price: bigint): void {
    this.execs.push({
      executionId: `fake-exec-${this.execs.length + 1}`, clientOrderId, instrumentId, side,
      quantity: qty.toString(), priceMinor: price.toString(), feeMinor: this.feeMinor.toString(), atMs: this.nowMs(),
    });
  }

  async executions(account: string, sinceMs: number): Promise<Execution[]> {
    await this.account(account);
    return structuredClone(this.execs.filter((e) => e.atMs >= sinceMs));
  }

  /** Test driver: a trade made in the account by someone else (not through our order ids). */
  externalTrade(instrumentId: string, side: 'BUY' | 'SELL', qty: string, priceMinor: string): void {
    const q = integer(qty, true);
    const p = integer(priceMinor, true);
    const held = this.externals.get(instrumentId) ?? 0n;
    if (side === 'SELL' && held < q) throw new Error('EXTERNAL_SELL_EXCEEDS_HOLDING');
    this.externals.set(instrumentId, side === 'BUY' ? held + q : held - q);
    this.cash += side === 'BUY' ? -(q * p) - this.feeMinor : q * p - this.feeMinor;
    this.record(null, instrumentId, side, q, p);
  }

  /** Test driver: cash that changes with no execution behind it (a fee the broker did not itemise, an adjustment). */
  skimCash(minor: bigint): void { this.cash -= minor; }

  async getOrder(account: string, id: string) {
    await this.account(account);
    return structuredClone(this.rows.get(this.key(account, id))?.order ?? null);
  }

  async cancel(account: string, id: string) {
    await this.account(account);
    const row = this.rows.get(this.key(account, id));
    if (!row) throw new Error('ORDER_NOT_FOUND');
    // Cancels only the unfilled entry. Shares already bought keep their stop and target.
    if (row.intent.kind === 'BUY_BRACKET' && (row.order.status === 'ACCEPTED' || row.order.status === 'PART_FILLED')) row.order.status = 'CANCELED';
    return structuredClone(row.order);
  }

  /** Test driver: the entry order has now filled `totalQuantity` shares in total, at `priceMinor`. */
  fill(id: string, totalQuantity: string, priceMinor: string): void {
    const row = this.rows.get(this.key(this.accountId, id));
    if (!row || row.intent.kind !== 'BUY_BRACKET') throw new Error('ORDER_NOT_FOUND');
    if (!['ACCEPTED', 'PART_FILLED'].includes(row.order.status)) throw new Error('TERMINAL_ORDER');
    const total = integer(totalQuantity, true);
    const old = integer(row.order.filledQuantity);
    const price = integer(priceMinor, true);
    if (total <= old || total > integer(row.intent.quantity) || price > integer(row.intent.entryLimitMinor)) throw new Error('INVALID_FILL');
    const incremental = (total - old) * price;
    if (incremental + this.feeMinor > this.cash) throw new Error('INSUFFICIENT_CASH');
    const cost = old * BigInt(row.order.averageFillMinor ?? '0') + incremental;
    if (cost % total !== 0n) throw new Error('NONINTEGRAL_FAKE_AVERAGE');
    this.cash -= incremental + this.feeMinor;
    this.record(id, row.intent.instrumentId, 'BUY', total - old, price);
    row.order.filledQuantity = total.toString();
    row.order.averageFillMinor = (cost / total).toString();
    row.order.protectedQuantity = this.remaining(row.order).toString();
    row.order.status = total === integer(row.intent.quantity) ? 'FILLED' : 'PART_FILLED';
  }

  /**
   * Test driver: the market price of an instrument is now `priceMinor`. Broker-held stops and
   * targets fire from here with no involvement of the worker. A stop fills at the observed price
   * (a gap through the stop is a worse fill, not the stop price); a target fills at the target.
   */
  tick(instrumentId: string, priceMinor: string): void {
    const price = integer(priceMinor, true);
    this.marks.set(instrumentId, price);
    for (const { intent, order } of this.brackets()) {
      if (intent.instrumentId !== instrumentId) continue;
      const prot = integer(order.protectedQuantity);
      if (prot === 0n) continue;
      if (price <= integer(intent.stopMinor)) this.exit(order, prot, price, 'STOP', instrumentId, intent.clientOrderId);
      else if (price >= integer(intent.targetMinor)) this.exit(order, prot, integer(intent.targetMinor), 'TARGET', instrumentId, intent.clientOrderId);
    }
  }
}
