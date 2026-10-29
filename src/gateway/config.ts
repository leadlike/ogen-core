import { z } from 'zod';

const MICRO_PER_CENT = 10_000n; // 1 USD = 1_000_000 micro = 100 cents

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((d) => {
  const t = new Date(`${d}T00:00:00Z`);
  return !Number.isNaN(t.getTime()) && t.toISOString().startsWith(d);
}, 'not a real calendar date');
const pct = z.number().positive().max(100);
const schema = z
  .object({
    capital: z.object({
      allocatedMicroUsd: z.number().int().positive(),
      maxPerPositionPct: pct,
      maxGrossExposurePct: pct,
      maxOpenPositions: z.number().int().positive().max(50),
    }).strict(),
    loss: z.object({
      perTradeRiskPct: pct,
      dailyLossLimitMicroUsd: z.number().int().positive(),
      maxDrawdownPct: pct,
      flattenOnDrawdown: z.boolean(),
      /** assumed cost of ONE order side (buy or sell); a round trip reserves twice this inside the trade's risk */
      feeReserveMicroUsd: z.number().int().nonnegative(),
    }).strict(),
    account: z.object({
      currency: z.string().regex(/^[A-Z]{3}$/),
      // This build cannot enable any of these; the schema refuses a config that tries.
      allowMargin: z.literal(false),
      allowShort: z.literal(false),
      allowFractional: z.literal(false),
    }).strict(),
    instruments: z.object({
      /** the only symbols this gateway will ever buy; anything else is refused whatever the worker asks */
      allowedSymbols: z.array(z.string().regex(/^[A-Z][A-Z0-9.\-]{0,9}$/)).min(1).max(500),
    }).strict(),
    quotes: z.object({
      maxAgeMs: z.number().int().positive(),
      /** widest bid/ask spread accepted for an entry, in basis points of the mid price (50 = 0.50%) */
      maxSpreadBps: z.number().int().positive().max(10_000),
    }).strict(),
    session: z.object({
      timezone: z.string().min(1),
      entryWindow: z.object({
        skipFirstMinutes: z.number().int().min(0).max(390),
        skipLastMinutes: z.number().int().min(0).max(390),
      }).strict(),
      /** one-off exchange closures the rules cannot know (ISO dates) */
      extraClosedDates: z.array(isoDate).max(366),
      extraEarlyCloseDates: z.array(isoDate).max(366),
    }).strict(),
    reconciliation: z.object({
      /** cash may differ from the books by at most this much (rounding, an unitemised fee) */
      allowedFeeVarianceMicroUsd: z.number().int().nonnegative(),
      /** an order left SUBMITTING/UNKNOWN longer than this is an unresolved exposure */
      unresolvedOrderAfterMs: z.number().int().positive(),
      /** re-read executions this far back each cycle; duplicates are ignored */
      executionOverlapMs: z.number().int().nonnegative(),
    }).strict(),
  })
  .strict();

export interface GatewayLimits {
  currency: string;
  /** all money below in integer minor units (cents) */
  allocatedMinor: bigint;
  perPositionMinor: bigint;
  grossExposureMinor: bigint;
  perTradeRiskMinor: bigint;
  feeReserveMinor: bigint;
  dailyLossMinor: bigint;
  maxDrawdownBp: bigint; // basis points of the high-water equity
  maxOpenPositions: number;
  flattenOnDrawdown: boolean;
  quoteMaxAgeMs: number;
  maxSpreadBps: bigint;
  allowedSymbols: ReadonlySet<string>;
  timezone: string;
  entryWindow: { skipFirstMinutes: number; skipLastMinutes: number; extraClosedDates: ReadonlySet<string>; extraEarlyCloseDates: ReadonlySet<string> };
  reconciliation: { allowedCashVarianceMinor: bigint; unresolvedOrderAfterMs: number; executionOverlapMs: number };
  /** what the stated percentages really allow once they interact; shown, never silently changed */
  notes: string[];
}

function bp(p: number, what: string): bigint {
  const v = Math.round(p * 100);
  if (Math.abs(v - p * 100) > 1e-6) throw new Error(`CONFIG: ${what} supports at most 2 decimals`);
  return BigInt(v);
}
function microToMinor(micro: number, what: string): bigint {
  const m = BigInt(micro);
  if (m % MICRO_PER_CENT !== 0n) throw new Error(`CONFIG: ${what} must be a whole number of cents`);
  return m / MICRO_PER_CENT;
}

export function parseGatewayConfig(raw: unknown): GatewayLimits {
  const c = schema.parse(raw);
  const allocated = microToMinor(c.capital.allocatedMicroUsd, 'allocatedMicroUsd');
  const of = (p: number, what: string) => (allocated * bp(p, what)) / 10_000n;
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: c.session.timezone });
  } catch {
    throw new Error(`CONFIG: unknown timezone ${c.session.timezone}`);
  }
  const lim: GatewayLimits = {
    currency: c.account.currency,
    allocatedMinor: allocated,
    perPositionMinor: of(c.capital.maxPerPositionPct, 'maxPerPositionPct'),
    grossExposureMinor: of(c.capital.maxGrossExposurePct, 'maxGrossExposurePct'),
    perTradeRiskMinor: of(c.loss.perTradeRiskPct, 'perTradeRiskPct'),
    feeReserveMinor: microToMinor(c.loss.feeReserveMicroUsd, 'feeReserveMicroUsd'),
    dailyLossMinor: microToMinor(c.loss.dailyLossLimitMicroUsd, 'dailyLossLimitMicroUsd'),
    maxDrawdownBp: bp(c.loss.maxDrawdownPct, 'maxDrawdownPct'),
    maxOpenPositions: c.capital.maxOpenPositions,
    flattenOnDrawdown: c.loss.flattenOnDrawdown,
    quoteMaxAgeMs: c.quotes.maxAgeMs,
    maxSpreadBps: BigInt(c.quotes.maxSpreadBps),
    allowedSymbols: new Set(c.instruments.allowedSymbols),
    timezone: c.session.timezone,
    entryWindow: {
      skipFirstMinutes: c.session.entryWindow.skipFirstMinutes,
      skipLastMinutes: c.session.entryWindow.skipLastMinutes,
      extraClosedDates: new Set(c.session.extraClosedDates),
      extraEarlyCloseDates: new Set(c.session.extraEarlyCloseDates),
    },
    reconciliation: {
      allowedCashVarianceMinor: microToMinor(c.reconciliation.allowedFeeVarianceMicroUsd, 'allowedFeeVarianceMicroUsd'),
      unresolvedOrderAfterMs: c.reconciliation.unresolvedOrderAfterMs,
      executionOverlapMs: c.reconciliation.executionOverlapMs,
    },
    notes: [],
  };
  // The calendar encodes NYSE/Nasdaq rules in US Eastern time; any other zone would silently shift the session.
  if (c.session.timezone !== 'America/New_York') throw new Error('CONFIG: session.timezone must be America/New_York (the market calendar is NYSE/Nasdaq)');
  if (c.session.entryWindow.skipFirstMinutes + c.session.entryWindow.skipLastMinutes >= 6.5 * 60 - 60) throw new Error('CONFIG: entryWindow leaves less than an hour to trade');
  if (lim.perPositionMinor > lim.grossExposureMinor) throw new Error('CONFIG: maxPerPositionPct exceeds maxGrossExposurePct');
  const reachable = lim.perPositionMinor * BigInt(lim.maxOpenPositions);
  if (reachable < lim.grossExposureMinor) {
    lim.notes.push(`maxOpenPositions x maxPerPositionPct caps exposure at ${reachable} minor units, below maxGrossExposurePct (${lim.grossExposureMinor}); the lower figure applies in practice`);
  }
  if (reachable > lim.grossExposureMinor) {
    lim.notes.push(`maxOpenPositions x maxPerPositionPct (${reachable}) exceeds maxGrossExposurePct (${lim.grossExposureMinor}) by ${reachable - lim.grossExposureMinor} minor units; the exposure cap prevails, so the last position is limited to what remains`);
  }
  if (lim.perTradeRiskMinor > lim.dailyLossMinor) lim.notes.push('one stopped-out trade can exceed the daily loss limit');
  return lim;
}
