import type { Micro, PricedPositionMark } from './types';

/**
 * Pure portfolio accounting over the append-only ledger and position records.
 * All amounts are integer micro-USD. Cash is ALWAYS derived from the ledger.
 */

export type LedgerKind = 'INIT' | 'DEPOSIT' | 'WITHDRAWAL' | 'BUY' | 'SELL' | 'FEE';

export interface LedgerEntry {
  kind: LedgerKind;
  /** signed cash delta */
  amountMicro: Micro;
  tsMs: number;
  positionId: string | null;
}

export interface ClosedTrade {
  id: string;
  mint: string;
  costMicro: Micro;
  proceedsMicro: Micro;
  entryFeeMicro: Micro;
  exitFeeMicro: Micro;
  openedAtMs: number;
  closedAtMs: number;
}
export const tradePnl = (t: ClosedTrade): Micro => t.proceedsMicro - t.costMicro - t.entryFeeMicro - t.exitFeeMicro;

export interface OpenPositionView {
  id: string;
  mint: string;
  costMicro: Micro;
  entryFeeMicro: Micro;
  mark: PricedPositionMark;
}

export interface TradeStats {
  closedTrades: number;
  wins: number;
  losses: number;
  breakeven: number;
  /** wins / closed trades; null until at least one trade has closed */
  winRate: number | null;
  avgWinMicro: Micro | null;
  avgLossMicro: Micro | null;
  expectancyMicro: Micro | null;
  /** gross profit / gross loss; null if there are no losses (undefined, not infinite) */
  profitFactor: number | null;
  grossProfitMicro: Micro;
  grossLossMicro: Micro;
}

export interface Portfolio {
  startingCapitalMicro: Micro;
  depositsMicro: Micro;
  withdrawalsMicro: Micro;
  netContributedMicro: Micro;
  cashMicro: Micro;
  reservedMicro: Micro;
  availableCashMicro: Micro;
  openPositionCount: number;
  openCostMicro: Micro;
  /** sum of per-position quoted values (price-snapshot mark); unpriceable positions contribute 0 and are counted */
  quotedValueMicro: Micro;
  /** sum of sell-quote values net of modeled exit costs; no route / unpriceable => 0 (conservative) */
  executableValueMicro: Micro;
  /** cash + quoted value (optimistic, chart-based) */
  nlvQuotedMicro: Micro;
  /** cash + executable value (what you could realistically get today) */
  nlvExecutableMicro: Micro;
  realizedPnlMicro: Micro;
  unrealizedQuotedMicro: Micro;
  unrealizedExecutableMicro: Micro;
  /** fees not attributable to a trade (e.g. failed transactions) */
  unattributedFeesMicro: Micro;
  totalFeesMicro: Micro;
  /** net P&L on executable basis: nlvExecutable - net contributions */
  netPnlExecutableMicro: Micro;
  netPnlQuotedMicro: Micro;
  staleCount: number;
  unpriceableCount: number;
  noSellRouteCount: number;
}

export function computePortfolio(args: {
  ledger: LedgerEntry[];
  open: OpenPositionView[];
  closed: ClosedTrade[];
  reservedMicro: Micro;
}): Portfolio {
  let init = 0;
  let deposits = 0;
  let withdrawals = 0;
  let cash = 0;
  let totalFees = 0;
  let attributedFees = 0;
  for (const e of args.ledger) {
    cash += e.amountMicro;
    if (e.kind === 'INIT') init += e.amountMicro;
    else if (e.kind === 'DEPOSIT') deposits += e.amountMicro;
    else if (e.kind === 'WITHDRAWAL') withdrawals += -e.amountMicro;
    else if (e.kind === 'FEE') {
      totalFees += -e.amountMicro;
      if (e.positionId) attributedFees += -e.amountMicro;
    }
  }

  let openCost = 0;
  let openFees = 0;
  let quoted = 0;
  let exec = 0;
  let stale = 0;
  let unpriceable = 0;
  let noRoute = 0;
  for (const p of args.open) {
    openCost += p.costMicro;
    openFees += p.entryFeeMicro;
    quoted += p.mark.quotedValueMicro ?? 0;
    exec += p.mark.executableValueMicro ?? 0;
    if (p.mark.stale) stale++;
    if (p.mark.unpriceable) unpriceable++;
    if (p.mark.noSellRoute) noRoute++;
  }

  const realized = args.closed.reduce((a, t) => a + tradePnl(t), 0);
  const netContributed = init + deposits - withdrawals;
  const nlvQ = cash + quoted;
  const nlvE = cash + exec;

  return {
    startingCapitalMicro: init,
    depositsMicro: deposits,
    withdrawalsMicro: withdrawals,
    netContributedMicro: netContributed,
    cashMicro: cash,
    reservedMicro: args.reservedMicro,
    availableCashMicro: cash - args.reservedMicro,
    openPositionCount: args.open.length,
    openCostMicro: openCost,
    quotedValueMicro: quoted,
    executableValueMicro: exec,
    nlvQuotedMicro: nlvQ,
    nlvExecutableMicro: nlvE,
    realizedPnlMicro: realized,
    unrealizedQuotedMicro: quoted - openCost - openFees,
    unrealizedExecutableMicro: exec - openCost - openFees,
    unattributedFeesMicro: totalFees - attributedFees,
    totalFeesMicro: totalFees,
    netPnlExecutableMicro: nlvE - netContributed,
    netPnlQuotedMicro: nlvQ - netContributed,
    staleCount: stale,
    unpriceableCount: unpriceable,
    noSellRouteCount: noRoute,
  };
}

export function computeTradeStats(closed: ClosedTrade[]): TradeStats {
  const pnls = closed.map(tradePnl);
  const winsArr = pnls.filter((p) => p > 0);
  const lossArr = pnls.filter((p) => p < 0);
  const n = pnls.length;
  const grossProfit = winsArr.reduce((a, b) => a + b, 0);
  const grossLoss = -lossArr.reduce((a, b) => a + b, 0);
  return {
    closedTrades: n,
    wins: winsArr.length,
    losses: lossArr.length,
    breakeven: n - winsArr.length - lossArr.length,
    winRate: n > 0 ? winsArr.length / n : null,
    avgWinMicro: winsArr.length ? Math.round(grossProfit / winsArr.length) : null,
    avgLossMicro: lossArr.length ? Math.round(-grossLoss / lossArr.length) : null,
    expectancyMicro: n > 0 ? Math.round(pnls.reduce((a, b) => a + b, 0) / n) : null,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : null,
    grossProfitMicro: grossProfit,
    grossLossMicro: grossLoss,
  };
}

/**
 * Max drawdown over a series of equity values that has been adjusted for
 * external cash flows (deposits/withdrawals) by the caller.
 */
export function maxDrawdown(series: Micro[]): { maxDrawdownPct: number; maxDrawdownMicro: Micro } {
  let peak = -Infinity;
  let ddPct = 0;
  let ddAbs = 0;
  for (const v of series) {
    if (v > peak) peak = v;
    if (peak > 0) {
      const d = peak - v;
      const p = (d / peak) * 100;
      if (p > ddPct) ddPct = p;
      if (d > ddAbs) ddAbs = d;
    }
  }
  return { maxDrawdownPct: Math.round(ddPct * 100) / 100, maxDrawdownMicro: ddAbs };
}

/** Value of an open position given a sell quote; null output => no executable value. */
export function markPosition(args: {
  nowMs: number;
  maxAgeMs: number;
  /** price snapshot value: qty * priceUsd, or null if no price */
  quotedValueMicro: Micro | null;
  quotedAtMs: number | null;
  /** sell quote USDC out (atomic == micro-USD for 6-decimals USDC) net of fixed exit fee, or null */
  executableValueMicro: Micro | null;
  executableAtMs: number | null;
  noSellRoute: boolean;
}): PricedPositionMark {
  const quotedFresh = args.quotedAtMs !== null && args.nowMs - args.quotedAtMs <= args.maxAgeMs;
  const execFresh = args.executableAtMs !== null && args.nowMs - args.executableAtMs <= args.maxAgeMs;
  const unpriceable = args.quotedValueMicro === null && args.executableValueMicro === null;
  return {
    quotedValueMicro: args.quotedValueMicro,
    executableValueMicro: args.noSellRoute ? null : args.executableValueMicro,
    markedAtMs: Math.max(args.quotedAtMs ?? 0, args.executableAtMs ?? 0),
    // "stale" = it had a price once but it has aged out; never-priced is "unpriceable" (not both)
    stale: !unpriceable && !(quotedFresh || execFresh),
    unpriceable,
    noSellRoute: args.noSellRoute,
  };
}
