import type { GatewayLimits } from '../gateway/config';

/** What the worker knows when it asks the strategy for ideas. All money in integer minor units. */
export interface Context {
  nowMs: number;
  /** ISO date of the New York trading day, used to build deterministic order ids */
  day: string;
  cashMinor: bigint;
  held: ReadonlySet<string>;
  /** symbols with an entry already sent today (or still in flight) */
  attemptedToday: ReadonlySet<string>;
  quotes: ReadonlyMap<string, { bidMinor: bigint; askMinor: bigint }>;
  limits: GatewayLimits;
}

export interface Idea { instrumentId: string; stopPct: number; targetPct: number }

/** A strategy only proposes. The gateway still decides whether any order may exist. */
export interface Strategy {
  readonly name: string;
  propose(ctx: Context): Idea[];
}

/**
 * v1 "probe" strategy. It has NO market edge and claims none: it takes one small, mechanically protected position
 * in an allowlisted symbol so the whole chain (sizing, gateway, bracket, fills, reconciliation) can be exercised on
 * paper and measured (slippage, fees, refusals). Replace it with a real strategy before judging any result.
 * One new idea per tick, symbols in alphabetical order, only when flat in that symbol and not yet tried today.
 */
export class ProbeStrategy implements Strategy {
  readonly name = 'probe-v1';
  constructor(private o: { stopPct?: number; targetPct?: number; symbols?: string[] } = {}) {}
  propose(ctx: Context): Idea[] {
    const pool = (this.o.symbols ?? [...ctx.limits.allowedSymbols]).filter((s) => ctx.limits.allowedSymbols.has(s)).sort();
    for (const s of pool) {
      if (ctx.held.has(s) || ctx.attemptedToday.has(s) || !ctx.quotes.has(s)) continue;
      return [{ instrumentId: s, stopPct: this.o.stopPct ?? 2, targetPct: this.o.targetPct ?? 3 }];
    }
    return [];
  }
}

/** Buy at the ask rounded up to the cent, stop and target as percent of that limit, whole shares, sized to the per-trade risk. */
export function sizeIdea(idea: Idea, q: { bidMinor: bigint; askMinor: bigint }, limits: GatewayLimits): { quantity: bigint; limit: bigint; stop: bigint; target: bigint } | null {
  const limit = q.askMinor;
  const pct = (p: number) => BigInt(Math.round(p * 100)); // basis points, 2 decimals
  const stop = limit - (limit * pct(idea.stopPct) + 9_999n) / 10_000n; // stop rounded DOWN (further away: more conservative sizing)
  const target = limit + (limit * pct(idea.targetPct)) / 10_000n;
  if (stop <= 0n || stop >= q.bidMinor || target <= limit) return null;
  const perShareRisk = limit - stop;
  const budget = limits.perTradeRiskMinor - 2n * limits.feeReserveMinor;
  if (budget <= 0n || perShareRisk <= 0n) return null;
  let qty = budget / perShareRisk;
  const cap = limits.perPositionMinor / limit;
  if (qty > cap) qty = cap;
  if (qty < 1n) return null;
  return { quantity: qty, limit, stop, target };
}
