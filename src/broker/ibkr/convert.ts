/** Money and time conversions at the IB boundary. Everything inside the project is integer cents and epoch ms. */

/** A TWS price (a JS number) to integer cents. Rejects NaN, infinities and negatives; never silently floors. */
export function toMinor(value: number | string, mode: 'round' | 'ceil' | 'floor' = 'round'): bigint {
  const n = typeof value === 'string' ? Number(value) : value;
  if (!Number.isFinite(n) || n < 0) throw new Error(`IB_INVALID_AMOUNT: ${String(value)}`);
  const scaled = n * 100;
  // 1e-6 absorbs binary floating error (e.g. 1.005 * 100) without hiding real fractions
  return BigInt(mode === 'ceil' ? Math.ceil(scaled - 1e-6) : mode === 'floor' ? Math.floor(scaled + 1e-6) : Math.round(scaled + 1e-6));
}

/** Cents to the decimal number TWS expects. Exact for any amount a cent price can produce. */
export function fromMinor(minor: string | bigint): number {
  const m = typeof minor === 'bigint' ? minor : BigInt(minor);
  if (m < 0n) throw new Error('IB_NEGATIVE_AMOUNT');
  return Number(`${m / 100n}.${(m % 100n).toString().padStart(2, '0')}`);
}

/** Whole, non-negative share count from a TWS quantity; fractional or negative quantities are an error, not a rounding. */
export function wholeShares(value: number, what = 'quantity'): bigint {
  if (!Number.isFinite(value) || value < 0 || !Number.isInteger(value)) throw new Error(`IB_NON_WHOLE_${what.toUpperCase()}: ${value}`);
  return BigInt(value);
}

function offsetMs(utcGuess: number, tz: string): number {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
      .formatToParts(new Date(utcGuess)).map((x) => [x.type, x.value]),
  );
  return Date.UTC(+p.year!, +p.month! - 1, +p.day!, +p.hour!, +p.minute!, +p.second!) - utcGuess;
}

/**
 * Execution time as TWS prints it: "yyyyMMdd HH:mm:ss" (+ optional zone name), or "yyyyMMdd-HH:mm:ss" (UTC).
 * Without a zone in the text the wall clock is read in `defaultZone` — which must be the zone TWS/IB Gateway runs in.
 */
export function parseExecTime(text: string, defaultZone: string): number {
  const m = /^(\d{4})(\d{2})(\d{2})([ -]{1,2})(\d{2}):(\d{2}):(\d{2})(?:\s+([A-Za-z_]+\/[A-Za-z_]+|UTC|GMT))?$/.exec(text.trim());
  if (!m) throw new Error(`IB_BAD_TIME: ${text}`);
  const [, y, mo, d, sep, h, mi, s, zone] = m;
  const wall = Date.UTC(+y!, +mo! - 1, +d!, +h!, +mi!, +s!);
  const tz = zone ?? (sep === '-' ? 'UTC' : defaultZone);
  if (tz === 'UTC' || tz === 'GMT') return wall;
  let guess = wall - offsetMs(wall, tz);
  guess = wall - offsetMs(guess, tz); // second pass settles the hour around a clock change
  return guess;
}
