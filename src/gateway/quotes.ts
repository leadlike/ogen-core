export interface Quote {
  /** integer minor units per share */
  priceMinor: string;
  /** when the price was observed at its source, epoch ms */
  asOfMs: number;
  /** best bid / best ask, integer minor units; entries are refused without them */
  bidMinor?: string;
  askMinor?: string;
}
/** Where fresh prices come from. A real implementation reads the broker's or a data vendor's feed. */
export interface QuoteSource {
  quote(instrumentId: string): Promise<Quote | null>;
}

/** Test double with prices set by the test. Not a market. */
export class StaticQuotes implements QuoteSource {
  private q = new Map<string, Quote>();
  /** without `book`, bid = ask = price (a zero spread); pass `book` to test wide or crossed markets */
  set(instrumentId: string, priceMinor: string, asOfMs: number, book?: { bid?: string; ask?: string }): void {
    const quote: Quote = { priceMinor, asOfMs };
    if (book) { if (book.bid !== undefined) quote.bidMinor = book.bid; if (book.ask !== undefined) quote.askMinor = book.ask; }
    else { quote.bidMinor = priceMinor; quote.askMinor = priceMinor; }
    this.q.set(instrumentId, quote);
  }
  clear(instrumentId: string): void { this.q.delete(instrumentId); }
  async quote(instrumentId: string): Promise<Quote | null> { return this.q.get(instrumentId) ?? null; }
}
