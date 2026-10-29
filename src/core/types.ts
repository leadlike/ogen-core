/**
 * Shared domain types. All monetary values inside the portfolio / ledger are
 * integer micro-USD (1 USD = 1_000_000). Token amounts are decimal strings of
 * atomic units (never JS numbers) so they survive JSON and cannot lose precision.
 */

export type Mode = 'DEMO' | 'PAPER' | 'BROKER_PAPER' | 'LIVE';
export const MODES: readonly Mode[] = ['DEMO', 'PAPER', 'BROKER_PAPER', 'LIVE'];

export type Action = 'WATCH' | 'WAIT' | 'REJECT' | 'ENTER' | 'EXIT' | 'ERROR' | 'HALT';

export type ModuleName = 'SCANNER' | 'SECURITY' | 'SIZER' | 'EXECUTOR' | 'LOGGER' | 'EQUITY';
export const MODULE_NAMES: readonly ModuleName[] = [
  'SCANNER',
  'SECURITY',
  'SIZER',
  'EXECUTOR',
  'LOGGER',
  'EQUITY',
];

/** Integer micro-USD. */
export type Micro = number;
export const MICRO = 1_000_000;
export const toMicro = (usd: number): Micro => Math.round(usd * MICRO);
export const fromMicro = (m: Micro): number => m / MICRO;

export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const USDC_DECIMALS = 6;
export const SOL_MINT = 'So11111111111111111111111111111111111111112';

export interface WindowedNumbers {
  m5: number | null;
  h1: number | null;
  h6: number | null;
  h24: number | null;
}
export interface WindowedTxns {
  m5: { buys: number; sells: number } | null;
  h1: { buys: number; sells: number } | null;
  h6: { buys: number; sells: number } | null;
  h24: { buys: number; sells: number } | null;
}

/** A normalized market snapshot for one pool. `symbol`/`name` are UNTRUSTED text. */
export interface MarketSnapshot {
  mint: string;
  pool: string;
  dexId: string;
  /** untrusted, sanitized, display only */
  symbol: string;
  quoteMint: string;
  priceUsd: number | null;
  liquidityUsd: number | null;
  volumeUsd: WindowedNumbers;
  txns: WindowedTxns;
  priceChangePct: WindowedNumbers;
  pairCreatedAtMs: number | null;
  /** when we fetched it */
  fetchedAtMs: number;
  provider: string;
  /** 'live' provider data, or 'fixture' for DEMO / tests */
  origin: 'live' | 'fixture';
}

export type SecurityStatus = 'PASS' | 'REJECT' | 'UNKNOWN';

export interface OnchainMintInfo {
  program: 'spl-token' | 'spl-token-2022' | 'unknown';
  decimals: number;
  supply: string;
  mintAuthority: string | null;
  freezeAuthority: string | null;
  /** Token-2022 extensions, parsed (jsonParsed `extensions`). */
  extensions: Array<{ extension: string; state: Record<string, unknown> }>;
  /** largest token accounts from RPC (authoritative amounts); null if unavailable */
  largestAccounts: Array<{ address: string; amountAtomic: string; owner: string | null }> | null;
  fetchedAtMs: number;
}

export interface GoPlusHolder {
  account: string;
  tag: string | null;
  /** raw provider value; unit (fraction vs percent) is not verified, so it is never used for decisions */
  percentRaw: number | null;
  isLocked: boolean;
}
export interface GoPlusEvidence {
  fetchedAtMs: number;
  trustedToken: boolean | null;
  mintable: boolean | null;
  freezable: boolean | null;
  closable: boolean | null;
  nonTransferable: boolean | null;
  balanceMutableAuthority: boolean | null;
  metadataMutable: boolean | null;
  transferHook: { present: boolean; maliciousAddress: boolean } | null;
  transferFeeBps: number | null;
  defaultAccountState: 0 | 1 | 2 | null;
  holders: GoPlusHolder[] | null;
  lpLocks: Array<{ pool: string; lockedPct: number | null; unlockAtMs: number | null }> | null;
}

export interface SecurityEvidence {
  mint: string;
  pool: string;
  onchain: OnchainMintInfo | null;
  onchainError: string | null;
  goplus: GoPlusEvidence | null;
  goplusError: string | null;
  /** addresses known to be pool / infra (excluded from holder concentration) */
  knownInfraAddresses: string[];
}

export interface SecurityVerdict {
  status: SecurityStatus;
  reasonCodes: string[];
  /** human-readable facts that justify the verdict */
  facts: string[];
  checkedAtMs: number;
  /** Always the literal disclaimer; a PASS is not a safety guarantee. */
  disclaimer: string;
  evidence: SecurityEvidence;
}

export interface Quote {
  /** 'buy' = USDC -> token, 'sell' = token -> USDC */
  side: 'buy' | 'sell';
  inputMint: string;
  outputMint: string;
  inAmountAtomic: string;
  outAmountAtomic: string;
  priceImpactPct: number | null;
  slippageBps: number | null;
  router: string | null;
  fetchedAtMs: number;
  /** hard expiry if the provider supplies one */
  expiresAtMs: number | null;
  provider: string;
  origin: 'live' | 'fixture';
}

export type PositionStatus = 'OPEN' | 'CLOSING' | 'CLOSED' | 'UNSELLABLE';
export type OrderSide = 'BUY' | 'SELL';
export type OrderStatus =
  | 'INTENT' // persisted, nothing sent
  | 'SUBMITTING' // signed, signature persisted, submission in flight
  | 'AMBIGUOUS' // submission outcome unknown; must reconcile before any retry
  | 'CONFIRMED'
  | 'FAILED' // definitively did not execute
  | 'EXPIRED' // definitively expired without landing
  | 'CANCELLED';

export const TERMINAL_ORDER_STATUS: readonly OrderStatus[] = ['CONFIRMED', 'FAILED', 'EXPIRED', 'CANCELLED'];

export interface PricedPositionMark {
  /** mark by the last quoted mid/price snapshot */
  quotedValueMicro: Micro | null;
  /** value of an actual sell quote for the full position, net of modeled costs */
  executableValueMicro: Micro | null;
  markedAtMs: number;
  stale: boolean;
  unpriceable: boolean;
  noSellRoute: boolean;
}

export const NOT_A_GUARANTEE =
  'PASS means no critical risk was found in the evidence available at the timestamp shown. It is not a guarantee of safety.';
