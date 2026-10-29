/**
 * US equity market calendar (NYSE/Nasdaq regular session), computed from the exchange's published
 * holiday RULES so it works for any year, not a hard-coded list.
 *
 * Limits, stated plainly:
 *  - It encodes the rules as published at the time of writing. Exchanges can change them, and
 *    one-off closures (days of mourning, emergencies) cannot be derived. Those go in the config
 *    (extraClosedDates / extraEarlyCloseDates). Re-check against the exchange's own calendar yearly.
 *  - Regular hours only: 09:30-16:00 US Eastern, 09:30-13:00 on early-close days.
 */

export const EXCHANGE_TZ = 'America/New_York';
const OPEN_MIN = 9 * 60 + 30;
const CLOSE_MIN = 16 * 60;
const EARLY_CLOSE_MIN = 13 * 60;

type YMD = { y: number; m: number; d: number };
const iso = ({ y, m, d }: YMD) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
const dow = ({ y, m, d }: YMD) => new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 Sun .. 6 Sat
const addDays = ({ y, m, d }: YMD, n: number): YMD => {
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
};

/** n-th (1-based) given weekday of a month. */
function nthWeekday(y: number, m: number, weekday: number, n: number): YMD {
  const first = dow({ y, m, d: 1 });
  return { y, m, d: 1 + ((weekday - first + 7) % 7) + (n - 1) * 7 };
}
function lastWeekday(y: number, m: number, weekday: number): YMD {
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const lastDow = dow({ y, m, d: last });
  return { y, m, d: last - ((lastDow - weekday + 7) % 7) };
}
/** Anonymous Gregorian algorithm (Meeus/Jones/Butcher). */
export function easterSunday(y: number): YMD {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100;
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return { y, m: month, d: day };
}
/** Fixed-date holiday: Saturday -> preceding Friday, Sunday -> following Monday. */
function observed(h: YMD): YMD {
  const w = dow(h);
  return w === 6 ? addDays(h, -1) : w === 0 ? addDays(h, 1) : h;
}

/** Full-day closures for a year, as ISO date -> name. */
export function holidays(year: number): Map<string, string> {
  const out = new Map<string, string>();
  const add = (name: string, d: YMD) => out.set(iso(d), name);
  // New Year's Day: Sunday -> Monday; Saturday -> NOT observed on the Friday (the market is open Dec 31).
  const ny = { y: year, m: 1, d: 1 };
  if (dow(ny) !== 6) add("New Year's Day", dow(ny) === 0 ? addDays(ny, 1) : ny);
  add('Martin Luther King Jr. Day', nthWeekday(year, 1, 1, 3));
  add("Washington's Birthday", nthWeekday(year, 2, 1, 3));
  add('Good Friday', addDays(easterSunday(year), -2));
  add('Memorial Day', lastWeekday(year, 5, 1));
  if (year >= 2022) add('Juneteenth', observed({ y: year, m: 6, d: 19 }));
  add('Independence Day', observed({ y: year, m: 7, d: 4 }));
  add('Labor Day', nthWeekday(year, 9, 1, 1));
  add('Thanksgiving Day', nthWeekday(year, 11, 4, 4));
  add('Christmas Day', observed({ y: year, m: 12, d: 25 }));
  return out;
}

/** 13:00 closes for a year (ISO dates). */
export function earlyCloses(year: number): Set<string> {
  const out = new Set<string>();
  const hol = holidays(year);
  const dayAfterThanksgiving = addDays(nthWeekday(year, 11, 4, 4), 1);
  out.add(iso(dayAfterThanksgiving));
  const jul3 = { y: year, m: 7, d: 3 };
  if (dow(jul3) >= 1 && dow(jul3) <= 4) out.add(iso(jul3)); // Jul 3 is Mon-Thu, i.e. Jul 4 is Tue-Fri
  const dec24 = { y: year, m: 12, d: 24 };
  if (dow(dec24) >= 1 && dow(dec24) <= 4) out.add(iso(dec24));
  for (const k of out) if (hol.has(k)) out.delete(k); // a holiday is not also an early close
  return out;
}

export interface CalendarExtras {
  extraClosedDates?: ReadonlySet<string>;
  extraEarlyCloseDates?: ReadonlySet<string>;
}
export interface Session { date: string; openMin: number; closeMin: number; early: boolean }

/** The trading session of an ISO date, or the reason there is none. */
export function sessionOn(date: string, extras: CalendarExtras = {}): { session: Session } | { closed: string } {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const w = dow({ y, m, d });
  if (w === 0 || w === 6) return { closed: 'WEEKEND' };
  if (extras.extraClosedDates?.has(date)) return { closed: 'SPECIAL_CLOSURE' };
  const hol = holidays(y).get(date);
  if (hol) return { closed: `HOLIDAY:${hol}` };
  const early = earlyCloses(y).has(date) || !!extras.extraEarlyCloseDates?.has(date);
  return { session: { date, openMin: OPEN_MIN, closeMin: early ? EARLY_CLOSE_MIN : CLOSE_MIN, early } };
}

/** Local exchange date and minutes since midnight for an instant (handles daylight saving time). */
export function exchangeLocal(ms: number): { date: string; minutes: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: EXCHANGE_TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(new Date(ms));
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return { date: `${get('year')}-${get('month')}-${get('day')}`, minutes: Number(get('hour')) * 60 + Number(get('minute')) };
}

export interface EntryWindow extends CalendarExtras {
  /** no new entries in the first N minutes after the open */
  skipFirstMinutes: number;
  /** no new entries in the last N minutes before the close */
  skipLastMinutes: number;
}
export type EntryDecision = { allowed: true; session: Session } | { allowed: false; code: 'MARKET_CLOSED' | 'OUTSIDE_ENTRY_WINDOW'; detail: string };

export function entryDecision(ms: number, w: EntryWindow): EntryDecision {
  const { date, minutes } = exchangeLocal(ms);
  const s = sessionOn(date, w);
  if ('closed' in s) return { allowed: false, code: 'MARKET_CLOSED', detail: `${date} ${s.closed}` };
  const first = s.session.openMin + w.skipFirstMinutes;
  const last = s.session.closeMin - w.skipLastMinutes;
  if (minutes < s.session.openMin) return { allowed: false, code: 'MARKET_CLOSED', detail: `${date} before the open` };
  if (minutes >= s.session.closeMin) return { allowed: false, code: 'MARKET_CLOSED', detail: `${date} after the close` };
  if (minutes < first || minutes >= last) {
    return { allowed: false, code: 'OUTSIDE_ENTRY_WINDOW', detail: `${date} ${minutes} min (entries ${first}-${last - 1}${s.session.early ? ', early close' : ''})` };
  }
  return { allowed: true, session: s.session };
}
