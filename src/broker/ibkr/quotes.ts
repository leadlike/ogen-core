import type { Quote, QuoteSource } from '../../gateway/quotes';
import type { IbClient } from './client';
import { toMinor } from './convert';

const TICK_BID_SIZE = 0, TICK_BID = 1, TICK_ASK = 2, TICK_ASK_SIZE = 3, TICK_LAST = 4;

interface Side { bid?: number; ask?: number; last?: number; asOfMs: number }

/**
 * Real-time bid/ask from IB, for the symbols the gateway is allowed to trade.
 *  - Only REAL-TIME ticks are used. Delayed and frozen ticks (field numbers 66+) are ignored, so an account without a
 *    market-data subscription yields no quote at all and entries are refused (NO_QUOTE) instead of trading on old prices.
 *  - A side with no price (IB sends -1) is cleared, not read as a price.
 *  - asOf is the moment THIS process last heard from the feed for that symbol; IB only sends changes, so a symbol that
 *    does not tick for longer than quotes.maxAgeMs goes stale and is refused. For liquid stocks and ETFs that is rare;
 *    for an illiquid one it fails closed, which is the intended direction.
 *  - bid is rounded down and ask up to the cent, so the spread seen by the risk checks is never narrower than the market's.
 */
export class IbkrQuotes implements QuoteSource {
  private book = new Map<string, Side>();
  private reqs = new Map<number, string>();
  private started = false;

  constructor(private client: IbClient, private symbols: ReadonlySet<string>, private o: { now?: () => number; firstTickWaitMs?: number; reqIdBase?: number } = {}) {
    const now = () => (this.o.now ?? Date.now)();
    client.on('tickPrice', (req, field, value) => {
      const sym = this.reqs.get(req);
      if (!sym) return;
      if (field !== TICK_BID && field !== TICK_ASK && field !== TICK_LAST) return; // delayed (66+) and everything else: ignored
      const s = this.book.get(sym) ?? { asOfMs: 0 };
      const v = Number.isFinite(value) && value > 0 ? value : undefined;
      if (field === TICK_BID) s.bid = v; else if (field === TICK_ASK) s.ask = v; else s.last = v;
      s.asOfMs = now();
      this.book.set(sym, s);
    });
    client.on('tickSize', (req, field) => {
      const sym = this.reqs.get(req);
      const s = sym ? this.book.get(sym) : undefined;
      if (s && (field === TICK_BID_SIZE || field === TICK_ASK_SIZE)) s.asOfMs = now();
    });
    client.on('connected', () => { if (this.started) this.subscribe(); });
  }

  /** Subscribes to every allowed symbol. Safe to call again after a reconnect. */
  start(): void { this.started = true; this.subscribe(); }
  stop(): void { for (const id of this.reqs.keys()) this.client.cancelMktData(id); this.reqs.clear(); this.started = false; }

  private subscribe(): void {
    this.client.reqRealTimeMarketData();
    for (const id of this.reqs.keys()) this.client.cancelMktData(id);
    this.reqs.clear();
    let id = this.o.reqIdBase ?? 5000;
    for (const symbol of this.symbols) {
      this.reqs.set(id, symbol);
      this.client.reqMktData(id, { symbol, secType: 'STK', exchange: 'SMART', currency: 'USD' });
      id++;
    }
  }

  async quote(instrumentId: string): Promise<Quote | null> {
    if (!this.symbols.has(instrumentId)) return null;
    const wait = this.o.firstTickWaitMs ?? 0;
    const t0 = Date.now();
    let s = this.book.get(instrumentId);
    while ((!s || s.bid === undefined || s.ask === undefined) && Date.now() - t0 < wait) {
      await new Promise((r) => setTimeout(r, 20));
      s = this.book.get(instrumentId);
    }
    if (!s || s.bid === undefined || s.ask === undefined) return null;
    const bid = toMinor(s.bid, 'floor'), ask = toMinor(s.ask, 'ceil');
    return { priceMinor: ((bid + ask) / 2n).toString(), asOfMs: s.asOfMs, bidMinor: bid.toString(), askMinor: ask.toString() };
  }
}
