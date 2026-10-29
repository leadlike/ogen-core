import {
  integer, OrderRefused, validateIntent,
  type Broker, type BrokerAccount, type BrokerOrder, type BrokerPosition, type BuyBracketIntent, type Execution, type OrderIntent,
} from '../broker/types';
import type { GatewayLimits } from './config';
import type { QuoteSource } from './quotes';
import { entryDecision } from './calendar';
import { StateFile, type GatewayState } from './state';

export interface RiskGatewayDeps {
  /** the real broker adapter (holds the credentials); the worker never sees it */
  broker: Broker;
  quotes: QuoteSource;
  limits: GatewayLimits;
  accountId: string;
  stateFile: StateFile;
  now?: () => number;
}

export interface Snapshot {
  equityMinor: bigint;
  cashMinor: bigint;
  positions: Array<{ instrumentId: string; quantity: bigint; markMinor: bigint }>;
  reservedMinor: bigint;
  reservedInstruments: Set<string>;
}

/** One promise chain: evaluations run strictly one after another, so two requests can never both pass on the same headroom. */
class Mutex {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn, fn);
    this.tail = result.catch(() => undefined);
    return result;
  }
}

/**
 * The risk boundary in front of a broker. It implements Broker, so the worker's executor talks to
 * it exactly as it would talk to the broker, but every BUY is checked here, with this process's
 * own view of the account and its own persisted state, whatever the worker believes.
 * CLOSE orders and cancels are never blocked by limits or breakers: reducing risk must always be possible.
 */
export class RiskGateway implements Broker {
  readonly capabilities;
  private mutex = new Mutex();
  private state: GatewayState | null;
  private now: () => number;
  /** set when another instance took over the lock: this one must not open new risk any more */
  private fenced = false;

  constructor(private d: RiskGatewayDeps) {
    this.capabilities = d.broker.capabilities;
    this.now = d.now ?? Date.now;
    d.stateFile.acquire(); // throws LOCKED: a second gateway on the same state must not start
    d.stateFile.onLockLost = () => { this.fenced = true; d.stateFile.audit({ event: 'FENCED', reason: 'single-instance lock lost' }); };
    try {
      this.state = d.stateFile.load(); // throws STATE_CORRUPT: refuse to run on unreadable memory
    } catch (e) {
      d.stateFile.release();
      throw e;
    }
  }

  /** Releases the single-instance lock. Call on shutdown; also released automatically at process exit. */
  close(): void { this.d.stateFile.release(); }

  // ---- pass-through reads -------------------------------------------------
  account(id: string): Promise<BrokerAccount> { this.own(id); return this.d.broker.account(id); }
  positions(id: string): Promise<BrokerPosition[]> { this.own(id); return this.d.broker.positions(id); }
  getOrder(id: string, clientOrderId: string): Promise<BrokerOrder | null> { this.own(id); return this.d.broker.getOrder(id, clientOrderId); }
  cancel(id: string, clientOrderId: string): Promise<BrokerOrder> { this.own(id); return this.d.broker.cancel(id, clientOrderId); }
  executions(id: string, sinceMs: number): Promise<Execution[]> { this.own(id); return this.d.broker.executions(id, sinceMs); }

  private own(id: string): void {
    if (id !== this.d.accountId) throw new OrderRefused('WRONG_ACCOUNT', id);
  }

  // ---- placement ----------------------------------------------------------
  async place(i: OrderIntent): Promise<BrokerOrder> {
    try {
      validateIntent(i);
    } catch (e) {
      throw this.refuse(i, 'INVALID_INTENT', (e as Error).message);
    }
    this.own(i.accountId);
    if (i.currency !== this.d.limits.currency) throw this.refuse(i, 'CURRENCY_MISMATCH');

    if (i.kind === 'CLOSE') return this.mutex.run(() => this.placeClose(i));
    return this.mutex.run(() => this.placeBuy(i));
  }

  private async placeClose(i: OrderIntent): Promise<BrokerOrder> {
    // No short selling: only shares actually held can be sold. No stop required, no breaker applies.
    const held = (await this.d.broker.positions(i.accountId)).find((p) => p.instrumentId === i.instrumentId);
    if (!held || integer(held.quantity) < integer(i.quantity)) throw this.refuse(i, 'NO_POSITION_TO_CLOSE');
    this.d.stateFile.audit({ decision: 'ALLOW', kind: 'CLOSE', clientOrderId: i.clientOrderId, instrumentId: i.instrumentId, quantity: i.quantity });
    return this.send(i);
  }

  private async placeBuy(i: BuyBracketIntent | OrderIntent): Promise<BrokerOrder> {
    if (i.kind !== 'BUY_BRACKET') throw this.refuse(i, 'INVALID_INTENT');
    const L = this.d.limits;
    const now = this.now();

    if (this.fenced) throw this.refuse(i, 'GATEWAY_FENCED', 'another gateway instance owns the state');

    // retry of an order already approved: the broker de-duplicates by client id; do not reserve twice
    const prior = this.state?.reservations[i.clientOrderId];
    if (prior) {
      if (prior.instrumentId !== i.instrumentId || prior.quantity !== i.quantity || prior.limitMinor !== i.entryLimitMinor) throw this.refuse(i, 'RESERVATION_MISMATCH');
      return this.send(i);
    }

    // a reconciliation freeze needs no market data to decide: say so first
    if (this.state?.breakers.reconciliation) throw this.refuse(i, 'BREAKER_RECONCILIATION', this.state.breakers.reconciliation.reason);

    // a symbol outside the allowlist is refused whatever the worker believes
    if (!L.allowedSymbols.has(i.instrumentId)) throw this.refuse(i, 'SYMBOL_NOT_ALLOWED', i.instrumentId);

    // new entries only during the regular session (US Eastern, exchange holidays, entry window)
    const session = entryDecision(now, L.entryWindow);
    if (!session.allowed) throw this.refuse(i, session.code, session.detail);

    // 1. a fresh price is mandatory
    const q = await this.d.quotes.quote(i.instrumentId);
    if (!q) throw this.refuse(i, 'NO_QUOTE');
    if (q.asOfMs > now + 2_000) throw this.refuse(i, 'QUOTE_FROM_THE_FUTURE');
    if (now - q.asOfMs > L.quoteMaxAgeMs) throw this.refuse(i, 'STALE_QUOTE', `${now - q.asOfMs} ms old, max ${L.quoteMaxAgeMs}`);
    const price = integer(q.priceMinor, true);
    const qty = integer(i.quantity, true);
    const limit = integer(i.entryLimitMinor, true);
    const stop = integer(i.stopMinor, true);
    if (stop >= price) throw this.refuse(i, 'STOP_NOT_BELOW_MARKET', `stop ${stop} >= market ${price}`);

    // bid/ask: a thin book makes the stop slip and the entry costly
    if (q.bidMinor === undefined || q.askMinor === undefined) throw this.refuse(i, 'NO_BID_ASK');
    let bid: bigint, ask: bigint;
    try { bid = integer(q.bidMinor, true); ask = integer(q.askMinor, true); } catch { throw this.refuse(i, 'INVALID_QUOTE', 'bid/ask not positive integers'); }
    if (ask < bid) throw this.refuse(i, 'INVALID_QUOTE', `crossed book bid ${bid} ask ${ask}`);
    if ((ask - bid) * 20_000n > L.maxSpreadBps * (ask + bid)) {
      throw this.refuse(i, 'SPREAD_TOO_WIDE', `bid ${bid} ask ${ask}, max ${L.maxSpreadBps} bps of mid`);
    }
    if (stop >= bid) throw this.refuse(i, 'STOP_NOT_BELOW_MARKET', `stop ${stop} >= bid ${bid}`);

    // 2. our own view of the account
    const snap = await this.snapshot();
    if (snap === 'UNPRICEABLE') throw this.refuse(i, 'EQUITY_UNAVAILABLE', 'a held position has no fresh price');
    const st = await this.rollAndEvaluate(snap);

    if (st.breakers.reconciliation) throw this.refuse(i, 'BREAKER_RECONCILIATION', st.breakers.reconciliation.reason);
    if (st.breakers.drawdown) throw this.refuse(i, 'BREAKER_DRAWDOWN');
    if (st.breakers.dailyLoss) throw this.refuse(i, 'BREAKER_DAILY_LOSS');

    // 3. risk of THIS trade: what is lost if the stop fills where it says
    // stop distance plus the fees of the entry and of the exit
    const risk = (limit - stop) * qty + 2n * L.feeReserveMinor;
    if (risk > L.perTradeRiskMinor) throw this.refuse(i, 'TRADE_RISK_TOO_HIGH', `${risk} > ${L.perTradeRiskMinor}`);

    // 4. size and count
    const notional = limit * qty;
    if (notional > L.perPositionMinor) throw this.refuse(i, 'POSITION_TOO_LARGE', `${notional} > ${L.perPositionMinor}`);
    const heldOrReserved = new Set([...snap.positions.map((p) => p.instrumentId), ...snap.reservedInstruments]);
    if (heldOrReserved.has(i.instrumentId)) throw this.refuse(i, 'INSTRUMENT_ALREADY_OPEN');
    if (heldOrReserved.size + 1 > L.maxOpenPositions) throw this.refuse(i, 'TOO_MANY_POSITIONS');
    // 3b. (after the structural checks) risk still open on other trades + this one must fit in what is left of today's loss limit
    const openRisk = this.openRisk(st, snap);
    const lostToday = BigInt(st.dayStartEquityMinor) - snap.equityMinor;
    const remaining = L.dailyLossMinor - (lostToday > 0n ? lostToday : 0n);
    if (openRisk + risk > (remaining > 0n ? remaining : 0n)) {
      throw this.refuse(i, 'OPEN_RISK_CAP', `open ${openRisk} + this ${risk} > remaining daily loss ${remaining > 0n ? remaining : 0n}`);
    }

    const held = snap.positions.reduce((s, p) => s + p.quantity * p.markMinor, 0n);
    if (held + snap.reservedMinor + notional > L.grossExposureMinor) throw this.refuse(i, 'EXPOSURE_CAP', `${held + snap.reservedMinor + notional} > ${L.grossExposureMinor}`);
    if (held + snap.reservedMinor + notional > L.allocatedMinor) throw this.refuse(i, 'ALLOCATION_CAP');

    // 5. no leverage: cash that is not already promised to other working entries
    if (notional > snap.cashMinor - snap.reservedMinor) throw this.refuse(i, 'INSUFFICIENT_UNRESERVED_CASH');

    // approved: reserve BEFORE sending, so a concurrent request sees this headroom as taken
    st.reservations[i.clientOrderId] = { instrumentId: i.instrumentId, quantity: i.quantity, limitMinor: i.entryLimitMinor, atMs: now };
    st.stops[i.instrumentId] = { limitMinor: i.entryLimitMinor, stopMinor: i.stopMinor, quantity: i.quantity };
    for (const k of Object.keys(st.stops)) if (!heldOrReserved.has(k) && k !== i.instrumentId) delete st.stops[k]; // positions that are gone
    this.persist(st);
    this.d.stateFile.audit({ decision: 'ALLOW', kind: 'BUY_BRACKET', clientOrderId: i.clientOrderId, instrumentId: i.instrumentId, quantity: i.quantity, riskMinor: risk.toString(), notionalMinor: notional.toString() });
    // If this throws or times out the order may exist: the reservation stays until a lookup resolves it.
    return this.send(i);
  }

  // ---- state and evaluation -----------------------------------------------
  private refuse(i: OrderIntent, code: string, detail = ''): OrderRefused {
    this.d.stateFile.audit({ decision: 'REFUSE', code, detail, clientOrderId: i.clientOrderId, instrumentId: i.instrumentId, kind: i.kind });
    return new OrderRefused(code, detail);
  }

  /** The only way an order leaves the gateway: ownership of the state lock is re-proved right before sending. */
  private send(i: OrderIntent): Promise<BrokerOrder> {
    try { this.d.stateFile.assertOwner(); } catch (e) { this.fenced = true; throw this.refuse(i, 'GATEWAY_FENCED', (e as Error).message); }
    return this.d.broker.place(i);
  }

  private persist(st: GatewayState): void {
    try { this.d.stateFile.assertOwner(); } catch (e) { this.fenced = true; throw new OrderRefused('GATEWAY_FENCED', (e as Error).message); }
    this.d.stateFile.save(st);
    this.state = st;
  }

  private dayKey(ms: number): string {
    return new Intl.DateTimeFormat('en-CA', { timeZone: this.d.limits.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
  }

  /** Cash, held positions at fresh prices, and the cash promised to entries that have not finished. */
  private async snapshot(): Promise<Snapshot | 'UNPRICEABLE'> {
    const id = this.d.accountId;
    const now = this.now();
    await this.reconcileReservations();
    const acct = await this.d.broker.account(id);
    const pos = await this.d.broker.positions(id);
    const positions: Snapshot['positions'] = [];
    for (const p of pos) {
      const q = await this.d.quotes.quote(p.instrumentId);
      if (!q || now - q.asOfMs > this.d.limits.quoteMaxAgeMs || q.asOfMs > now + 2_000) return 'UNPRICEABLE';
      positions.push({ instrumentId: p.instrumentId, quantity: integer(p.quantity), markMinor: integer(q.priceMinor, true) });
    }
    const res = this.state?.reservations ?? {};
    let reserved = 0n;
    const reservedInstruments = new Set<string>();
    for (const r of Object.values(res)) {
      reserved += integer(r.quantity) * integer(r.limitMinor);
      reservedInstruments.add(r.instrumentId);
    }
    const cash = integer(acct.cashMinor);
    return { cashMinor: cash, equityMinor: cash + positions.reduce((s, p) => s + p.quantity * p.markMinor, 0n), positions, reservedMinor: reserved, reservedInstruments };
  }

  /**
   * What would be lost if every stop filled at its price: for each instrument, (entry limit - stop) x the
   * shares held or still working, never more than were approved. A holding the gateway has no stop for
   * (it did not approve it) counts at its full market value, because nothing is known to limit it.
   */
  private openRisk(st: GatewayState, snap: Snapshot): bigint {
    let total = 0n;
    const working = new Map<string, bigint>();
    for (const r of Object.values(st.reservations)) working.set(r.instrumentId, (working.get(r.instrumentId) ?? 0n) + integer(r.quantity));
    for (const p of snap.positions) {
      const s = st.stops[p.instrumentId];
      if (!s) { total += p.quantity * p.markMinor; continue; }
      const q = p.quantity + (working.get(p.instrumentId) ?? 0n);
      const active = q < integer(s.quantity) ? q : integer(s.quantity);
      total += (integer(s.limitMinor) - integer(s.stopMinor)) * active + 2n * this.d.limits.feeReserveMinor;
      working.delete(p.instrumentId);
    }
    for (const [inst, q] of working) {
      const s = st.stops[inst];
      if (!s) continue;
      total += (integer(s.limitMinor) - integer(s.stopMinor)) * q + 2n * this.d.limits.feeReserveMinor;
    }
    return total;
  }

  /** Asks the broker what became of each approved entry; filled shares are then seen as positions. */
  private async reconcileReservations(): Promise<void> {
    if (!this.state) return;
    let changed = false;
    const next: GatewayState = { ...this.state, reservations: { ...this.state.reservations } };
    for (const [cid, r] of Object.entries(this.state.reservations)) {
      const o = await this.d.broker.getOrder(this.d.accountId, cid).catch(() => null);
      if (!o) continue; // not visible: it may still exist, so the reservation stays
      if (o.status === 'FILLED' || o.status === 'CANCELED' || o.status === 'REJECTED') {
        delete next.reservations[cid];
        changed = true;
      } else if (o.status === 'PART_FILLED') {
        const left = integer(r.quantity) - integer(o.filledQuantity);
        if (left.toString() !== r.quantity) { next.reservations[cid] = { ...r, quantity: left.toString() }; changed = true; }
      }
    }
    if (changed) this.persist(next);
  }

  /** Day roll-over, high-water mark and breakers. Always called with the mutex held. */
  private async rollAndEvaluate(snap: Snapshot): Promise<GatewayState> {
    const now = this.now();
    const day = this.dayKey(now);
    const eq = snap.equityMinor.toString();
    let st = this.state;
    if (!st) {
      st = { version: 1, day, dayStartEquityMinor: eq, highWaterMinor: eq, breakers: { dailyLoss: null, drawdown: null, reconciliation: null }, reservations: {}, flattened: [], stops: {} };
    } else {
      st = structuredClone(st);
      if (st.day !== day) { st.day = day; st.dayStartEquityMinor = eq; st.breakers.dailyLoss = null; st.flattened = []; }
    }
    if (snap.equityMinor > BigInt(st.highWaterMinor)) st.highWaterMinor = eq;

    const L = this.d.limits;
    const lost = BigInt(st.dayStartEquityMinor) - snap.equityMinor;
    if (!st.breakers.dailyLoss && lost >= L.dailyLossMinor) {
      st.breakers.dailyLoss = { reason: `loss ${lost} >= ${L.dailyLossMinor}`, atMs: now, equityMinor: eq };
      this.d.stateFile.audit({ event: 'BREAKER', which: 'dailyLoss', lost: lost.toString(), equity: eq });
    }
    const hw = BigInt(st.highWaterMinor);
    const down = ((hw - snap.equityMinor) * 10_000n);
    if (!st.breakers.drawdown && hw > 0n && down >= L.maxDrawdownBp * hw) {
      st.breakers.drawdown = { reason: `equity ${eq} is ${down / hw} bp below high-water ${hw}`, atMs: now, equityMinor: eq };
      this.d.stateFile.audit({ event: 'BREAKER', which: 'drawdown', equity: eq, highWater: hw.toString() });
    }
    this.persist(st);
    return st;
  }

  // ---- operations ---------------------------------------------------------
  /**
   * Periodic check (run it on a timer). Trips breakers even when nobody is trying to buy, and, if
   * configured, sells everything once on a drawdown breach. Returns the state after evaluation.
   */
  evaluate(): Promise<{ breakers: GatewayState['breakers']; flattened: string[] } | 'UNPRICEABLE'> {
    return this.mutex.run(async () => {
      const snap = await this.snapshot();
      if (snap === 'UNPRICEABLE') return 'UNPRICEABLE' as const;
      const st = await this.rollAndEvaluate(snap);
      const done: string[] = [];
      if (st.breakers.drawdown && this.d.limits.flattenOnDrawdown) {
        for (const p of snap.positions) {
          const cid = `gw-flatten-${st.day}-${p.instrumentId}`;
          if (st.flattened.includes(cid)) continue;
          try {
            this.d.stateFile.assertOwner();
            await this.d.broker.place({ kind: 'CLOSE', mode: 'BROKER_PAPER', accountId: this.d.accountId, clientOrderId: cid, instrumentId: p.instrumentId, currency: this.d.limits.currency, quantity: p.quantity.toString() });
            st.flattened.push(cid);
            done.push(cid);
            this.persist(st);
            this.d.stateFile.audit({ event: 'FLATTEN', clientOrderId: cid, instrumentId: p.instrumentId, quantity: p.quantity.toString() });
          } catch (e) {
            this.d.stateFile.audit({ event: 'FLATTEN_FAILED', clientOrderId: cid, error: (e as Error).message });
          }
        }
      }
      return { breakers: st.breakers, flattened: done };
    });
  }

  /**
   * Freezes new entries because the books and the broker disagree. Callable by the worker (it can only make
   * things stricter); clearing it needs the operator. The first reason is kept, later ones are only logged.
   */
  halt(reason: string): Promise<void> {
    return this.mutex.run(async () => {
      const now = this.now();
      const st: GatewayState = this.state
        ? structuredClone(this.state)
        : { version: 1, day: this.dayKey(now), dayStartEquityMinor: '0', highWaterMinor: '0', breakers: { dailyLoss: null, drawdown: null, reconciliation: null }, reservations: {}, flattened: [], stops: {} };
      this.d.stateFile.audit({ event: 'HALT_REQUESTED', reason, alreadyHalted: !!st.breakers.reconciliation });
      if (st.breakers.reconciliation) return;
      st.breakers.reconciliation = { reason: reason.slice(0, 500), atMs: now, equityMinor: '0' };
      this.persist(st);
    });
  }

  resumeAfterReconciliation(note: string): Promise<void> {
    return this.mutex.run(async () => {
      if (!this.state?.breakers.reconciliation) return;
      const st = structuredClone(this.state);
      st.breakers.reconciliation = null;
      this.persist(st);
      this.d.stateFile.audit({ event: 'RECONCILIATION_RESUME', note });
    });
  }

  /** Holdings with fresh prices (null when none), for display. Read-only apart from reconciling reservations. */
  capitalView(): Promise<{ cashMinor: string; positions: Array<{ instrumentId: string; quantity: string; costMinor: string; markMinor: string | null }> }> {
    return this.mutex.run(async () => {
      await this.reconcileReservations();
      const id = this.d.accountId;
      const now = this.now();
      const acct = await this.d.broker.account(id);
      const out = [];
      for (const p of await this.d.broker.positions(id)) {
        const q = await this.d.quotes.quote(p.instrumentId);
        const fresh = q && now - q.asOfMs <= this.d.limits.quoteMaxAgeMs && q.asOfMs <= now + 2_000;
        out.push({ instrumentId: p.instrumentId, quantity: p.quantity, costMinor: p.costMinor, markMinor: fresh ? q.priceMinor : null });
      }
      return { cashMinor: acct.cashMinor, positions: out };
    });
  }

  /** The drawdown breaker is sticky. Only an explicit call clears it, and it restarts the high-water mark. */
  resetDrawdown(note: string): Promise<void> {
    return this.mutex.run(async () => {
      const snap = await this.snapshot();
      if (snap === 'UNPRICEABLE') throw new Error('EQUITY_UNAVAILABLE');
      const st = structuredClone(this.state);
      if (!st) return;
      st.breakers.drawdown = null;
      st.highWaterMinor = snap.equityMinor.toString();
      this.persist(st);
      this.d.stateFile.audit({ event: 'DRAWDOWN_RESET', note, equity: snap.equityMinor.toString() });
    });
  }

  /** Releases a reservation an operator has confirmed does not exist at the broker. */
  releaseReservation(clientOrderId: string, note: string): Promise<void> {
    return this.mutex.run(async () => {
      if (!this.state?.reservations[clientOrderId]) return;
      const st = structuredClone(this.state);
      delete st.reservations[clientOrderId];
      this.persist(st);
      this.d.stateFile.audit({ event: 'RESERVATION_RELEASED', clientOrderId, note });
    });
  }

  status(): GatewayState | null { return this.state ? structuredClone(this.state) : null; }
}
