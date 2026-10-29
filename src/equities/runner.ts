import { BrokerExecutor } from '../broker/executor';
import { OrderRefused, type Broker, type BuyBracketIntent, type OrderIntent } from '../broker/types';
import type { ReconcileResult } from '../broker/reconcile';
import type { GatewayLimits } from '../gateway/config';
import { entryDecision, exchangeLocal } from '../gateway/calendar';
import { sizeIdea, type Strategy } from './strategy';

type Quoting = { quote(instrumentId: string): Promise<{ priceMinor: string; bidMinor: string | null; askMinor: string | null; asOfMs: number } | null> };
export interface RunnerDeps {
  broker: Broker & Quoting;
  executor: BrokerExecutor;
  strategy: Strategy;
  limits: GatewayLimits;
  accountId: string;
  /** true if an entry with this client order id already exists (durable, survives a restart) */
  alreadyTried: (clientOrderId: string) => Promise<boolean>;
  /** non-final intents, so their stored state follows the broker */
  openIntents: () => Promise<OrderIntent[]>;
  reconcile?: () => Promise<ReconcileResult>;
  reconcileEveryMs?: number;
  now?: () => number;
  log?: (level: 'info' | 'warn' | 'error', msg: string, f?: Record<string, unknown>) => void;
}

export interface TickReport { skipped?: string; submitted?: string; refused?: string; refreshed: number; reconciled?: string }

/**
 * One pass of the loop. It never talks to the broker directly: orders go gateway -> broker, and anything the
 * gateway refuses stays refused. Errors are logged and the next tick tries again; an uncertain submission is
 * resolved by lookup, never by sending again (BrokerExecutor).
 */
export class Runner {
  private lastReconcile = 0;
  private refusedToday = new Set<string>();
  private refusedDay = '';
  constructor(private d: RunnerDeps) {}
  private now() { return (this.d.now ?? Date.now)(); }
  private log(level: 'info' | 'warn' | 'error', msg: string, f?: Record<string, unknown>) { this.d.log?.(level, msg, f); }

  async tick(): Promise<TickReport> {
    const rep: TickReport = { refreshed: 0 };
    const t = this.now();

    // 1. keep stored order states in line with the broker (also outside entry hours: stops and targets fill any time)
    try {
      for (const i of await this.d.openIntents()) {
        try { await this.d.executor.refresh(i); rep.refreshed++; } catch (e) { this.log('warn', 'refresh failed', { id: i.clientOrderId, error: (e as Error).message }); }
      }
    } catch (e) { this.log('error', 'open intents unreadable', { error: (e as Error).message }); }

    // 2. reconcile on a schedule
    if (this.d.reconcile && t - this.lastReconcile >= (this.d.reconcileEveryMs ?? 300_000)) {
      this.lastReconcile = t;
      try {
        const r = await this.d.reconcile();
        rep.reconciled = r.status;
        if (r.status !== 'OK') this.log('error', 'reconciliation not OK', { status: r.status, halted: r.halted });
      } catch (e) { this.log('error', 'reconciliation failed', { error: (e as Error).message }); }
    }

    // 3. entries
    const win = this.d.limits.entryWindow;
    const dec = entryDecision(t, { skipFirstMinutes: win.skipFirstMinutes, skipLastMinutes: win.skipLastMinutes, extraClosedDates: win.extraClosedDates, extraEarlyCloseDates: win.extraEarlyCloseDates });
    if (!dec.allowed) { rep.skipped = dec.code; return rep; }
    const day = exchangeLocal(t).date;
    if (day !== this.refusedDay) { this.refusedDay = day; this.refusedToday = new Set(); }

    let account, positions;
    try { [account, positions] = await Promise.all([this.d.broker.account(this.d.accountId), this.d.broker.positions(this.d.accountId)]); }
    catch (e) { rep.skipped = 'BROKER_UNREADABLE'; this.log('warn', 'account unreadable', { error: (e as Error).message }); return rep; }
    const held = new Set(positions.map((p) => p.instrumentId));

    const quotes = new Map<string, { bidMinor: bigint; askMinor: bigint }>();
    const attempted = new Set<string>(this.refusedToday);
    for (const s of this.d.limits.allowedSymbols) {
      if (await this.d.alreadyTried(this.cid(day, s))) attempted.add(s);
      if (held.has(s) || attempted.has(s)) continue;
      try {
        const q = await this.d.broker.quote(s);
        if (q && q.bidMinor && q.askMinor && t - q.asOfMs <= this.d.limits.quoteMaxAgeMs) quotes.set(s, { bidMinor: BigInt(q.bidMinor), askMinor: BigInt(q.askMinor) });
      } catch (e) { this.log('warn', 'quote failed', { symbol: s, error: (e as Error).message }); }
    }

    const ideas = this.d.strategy.propose({ nowMs: t, day, cashMinor: BigInt(account.cashMinor), held, attemptedToday: attempted, quotes, limits: this.d.limits });
    const idea = ideas[0];
    if (!idea) return rep;
    const q = quotes.get(idea.instrumentId);
    const sized = q && sizeIdea(idea, q, this.d.limits);
    if (!sized) { this.refusedToday.add(idea.instrumentId); rep.skipped = 'NOT_SIZEABLE'; this.log('info', 'idea not sizeable', { symbol: idea.instrumentId }); return rep; }

    const intent: BuyBracketIntent = {
      kind: 'BUY_BRACKET', mode: 'BROKER_PAPER', accountId: this.d.accountId, clientOrderId: this.cid(day, idea.instrumentId),
      instrumentId: idea.instrumentId, currency: this.d.limits.currency, quantity: sized.quantity.toString(),
      entryLimitMinor: sized.limit.toString(), stopMinor: sized.stop.toString(), targetMinor: sized.target.toString(),
    };
    try {
      await this.d.executor.submit(intent);
      rep.submitted = intent.clientOrderId;
      this.log('info', 'entry submitted', { id: intent.clientOrderId, symbol: intent.instrumentId, qty: intent.quantity, limit: intent.entryLimitMinor, stop: intent.stopMinor, target: intent.targetMinor, strategy: this.d.strategy.name });
    } catch (e) {
      if (e instanceof OrderRefused) { this.refusedToday.add(idea.instrumentId); rep.refused = e.code; this.log('info', 'entry refused', { symbol: idea.instrumentId, code: e.code }); }
      else this.log('warn', 'entry uncertain; will be resolved by lookup, never resent', { id: intent.clientOrderId, error: (e as Error).message });
    }
    return rep;
  }

  private cid(day: string, symbol: string) { return `ogen-${day}-${symbol}`; }
}
