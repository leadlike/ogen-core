import type pg from 'pg';
import { integer, type Broker, type Execution } from './types';

export interface ReconcileOptions {
  broker: Broker;
  pool: pg.Pool;
  accountId: string;
  currency: string;
  /** cash may differ from our books by at most this much (rounding, an unitemised fee) */
  allowedCashVarianceMinor: bigint;
  /** a SUBMITTING/UNKNOWN order older than this is exposure we cannot account for */
  unresolvedOrderAfterMs: number;
  /** re-read executions this far back each run; duplicates are ignored */
  executionOverlapMs: number;
  /** order ids created by the gateway itself, which have no row in broker_order_intents */
  ownOrderPrefixes?: string[];
  /** freezes new entries. Must only ever make things stricter. */
  halt: (reason: string) => Promise<void>;
  now?: () => number;
}

export type Finding =
  | { code: 'CASH_DRIFT'; expectedMinor: string; observedMinor: string; diffMinor: string; allowedMinor: string }
  | { code: 'POSITION_MISMATCH'; instrumentId: string; expected: string; observed: string }
  | { code: 'EXTERNAL_EXECUTION'; executionId: string; clientOrderId: string | null; instrumentId: string }
  | { code: 'EXECUTION_CONTENT_CHANGED'; executionId: string }
  | { code: 'UNRESOLVED_ORDER'; clientOrderId: string; status: string; ageMs: number }
  | { code: 'INVALID_EXECUTION'; executionId: string; reason: string };

export interface ReconcileResult {
  status: 'OK' | 'MISMATCH';
  findings: Finding[];
  expected: { cashMinor: string; positions: Record<string, string> };
  observed: { cashMinor: string; positions: Record<string, string> };
  newExecutions: number;
  halted: boolean;
}

/** Cash and positions our books say we should have, from the baseline and the stored executions only. */
export async function expectedBooks(pool: pg.Pool, accountId: string): Promise<{ cashMinor: bigint; positions: Map<string, bigint> } | null> {
  const base = await pool.query(`select cash_minor::text as c from broker_baselines where mode='BROKER_PAPER' and account_id=$1`, [accountId]);
  if (!base.rows[0]) return null;
  const flow = await pool.query(
    `select coalesce(sum(case side when 'SELL' then quantity*price_minor else -quantity*price_minor end - fee_minor), 0)::text as cash
       from broker_executions where mode='BROKER_PAPER' and account_id=$1`,
    [accountId],
  );
  const pos = await pool.query(
    `select instrument_id, sum(case side when 'BUY' then quantity else -quantity end)::text as qty
       from broker_executions where mode='BROKER_PAPER' and account_id=$1 group by instrument_id`,
    [accountId],
  );
  const positions = new Map<string, bigint>();
  for (const r of pos.rows) if (BigInt(r.qty) !== 0n) positions.set(r.instrument_id, BigInt(r.qty));
  return { cashMinor: BigInt(base.rows[0].c) + BigInt(flow.rows[0].cash), positions };
}

export class BrokerBooks {
  constructor(private pool: pg.Pool, private accountId: string) {}

  /** Starting cash, once. Setting the same value again is a no-op; a different value is refused. */
  async setBaseline(cashMinor: bigint, note: string): Promise<void> {
    const ins = await this.pool.query(
      `insert into broker_baselines(mode, account_id, cash_minor, note) values ('BROKER_PAPER', $1, $2, $3) on conflict do nothing`,
      [this.accountId, cashMinor.toString(), note],
    );
    if (ins.rowCount === 1) return;
    const cur = await this.pool.query(`select cash_minor::text as c from broker_baselines where mode='BROKER_PAPER' and account_id=$1`, [this.accountId]);
    if (BigInt(cur.rows[0].c) !== cashMinor) throw new Error('BASELINE_ALREADY_SET');
  }

  /** Stores executions; ones already stored are ignored, unless their content differs. */
  async ingest(execs: Execution[]): Promise<{ inserted: number; changed: string[] }> {
    let inserted = 0;
    const changed: string[] = [];
    for (const e of execs) {
      const r = await this.pool.query(
        `insert into broker_executions(mode, account_id, execution_id, client_order_id, instrument_id, side, quantity, price_minor, fee_minor, executed_at)
         values ('BROKER_PAPER', $1, $2, $3, $4, $5, $6, $7, $8, to_timestamp($9::float8 / 1000.0))
         on conflict (mode, account_id, execution_id) do nothing`,
        [this.accountId, e.executionId, e.clientOrderId, e.instrumentId, e.side, e.quantity, e.priceMinor, e.feeMinor, e.atMs],
      );
      if (r.rowCount === 1) { inserted++; continue; }
      const prior = await this.pool.query(
        `select client_order_id, instrument_id, side, quantity::text as q, price_minor::text as p, fee_minor::text as f
           from broker_executions where mode='BROKER_PAPER' and account_id=$1 and execution_id=$2`,
        [this.accountId, e.executionId],
      );
      const x = prior.rows[0];
      if (x.client_order_id !== e.clientOrderId || x.instrument_id !== e.instrumentId || x.side !== e.side || x.q !== e.quantity || x.p !== e.priceMinor || x.f !== e.feeMinor) changed.push(e.executionId);
    }
    return { inserted, changed };
  }

  /** Records that an operator has looked at a foreign execution and accepts it. Stops it being flagged. */
  async acknowledge(executionId: string, note: string): Promise<void> {
    await this.pool.query(
      `insert into broker_execution_acks(mode, account_id, execution_id, note) values ('BROKER_PAPER', $1, $2, $3) on conflict do nothing`,
      [this.accountId, executionId, note],
    );
  }

  async latestExecutionMs(): Promise<number | null> {
    const r = await this.pool.query(`select (extract(epoch from max(executed_at)) * 1000)::float8 as ms from broker_executions where mode='BROKER_PAPER' and account_id=$1`, [this.accountId]);
    return r.rows[0].ms === null ? null : Math.floor(r.rows[0].ms);
  }
}

/**
 * Compares what the broker reports (cash, positions) against our own append-only books (baseline
 * plus every execution the broker has reported). Any disagreement beyond the tolerance, any
 * execution we did not originate, and any order whose fate is still unknown, freezes new entries.
 * Resuming is a deliberate human action at the gateway; a later clean run never un-freezes by itself.
 */
export class Reconciler {
  private books: BrokerBooks;
  constructor(private o: ReconcileOptions) {
    this.books = new BrokerBooks(o.pool, o.accountId);
  }

  async run(): Promise<ReconcileResult> {
    const o = this.o;
    const now = (o.now ?? Date.now)();
    const findings: Finding[] = [];

    // 1. pull executions (overlapping window, idempotent) and store them
    const last = await this.books.latestExecutionMs();
    const since = last === null ? 0 : Math.max(0, last - o.executionOverlapMs);
    const execs = await o.broker.executions(o.accountId, since);
    const valid: Execution[] = [];
    for (const e of execs) {
      try {
        integer(e.quantity, true); integer(e.priceMinor, true); integer(e.feeMinor);
        valid.push(e);
      } catch (err) {
        findings.push({ code: 'INVALID_EXECUTION', executionId: e.executionId, reason: (err as Error).message });
      }
    }
    const ing = await this.books.ingest(valid);
    for (const id of ing.changed) findings.push({ code: 'EXECUTION_CONTENT_CHANGED', executionId: id });

    // 2. executions we did not originate and nobody has acknowledged. Computed from the stored books,
    //    not from this run's batch, so a crash between storing and halting cannot lose the finding.
    const prefixes = (o.ownOrderPrefixes ?? []).map((p) => p.replace(/[\\%_]/g, '\\$&') + '%');
    const foreign = await o.pool.query(
      `select e.execution_id, e.client_order_id, e.instrument_id
         from broker_executions e
        where e.mode='BROKER_PAPER' and e.account_id=$1
          and not exists (select 1 from broker_execution_acks a where a.mode=e.mode and a.account_id=e.account_id and a.execution_id=e.execution_id)
          and (e.client_order_id is null
               or (not exists (select 1 from broker_order_intents i where i.mode=e.mode and i.account_id=e.account_id and i.client_order_id=e.client_order_id)
                   and not (e.client_order_id like any ($2::text[]))))
        order by e.executed_at, e.execution_id`,
      [o.accountId, prefixes],
    );
    for (const r of foreign.rows) findings.push({ code: 'EXTERNAL_EXECUTION', executionId: r.execution_id, clientOrderId: r.client_order_id, instrumentId: r.instrument_id });

    // 3. books vs the broker's own numbers
    const exp = await expectedBooks(o.pool, o.accountId);
    if (!exp) throw new Error('BASELINE_MISSING: set the starting cash before reconciling');
    const acct = await o.broker.account(o.accountId);
    const pos = await o.broker.positions(o.accountId);
    const observedPos = new Map<string, bigint>();
    for (const p of pos) observedPos.set(p.instrumentId, integer(p.quantity));
    const observedCash = integer(acct.cashMinor);

    const diff = observedCash - exp.cashMinor;
    const absDiff = diff < 0n ? -diff : diff;
    if (absDiff > o.allowedCashVarianceMinor) {
      findings.push({ code: 'CASH_DRIFT', expectedMinor: exp.cashMinor.toString(), observedMinor: observedCash.toString(), diffMinor: diff.toString(), allowedMinor: o.allowedCashVarianceMinor.toString() });
    }
    for (const inst of new Set([...exp.positions.keys(), ...observedPos.keys()])) {
      const a = exp.positions.get(inst) ?? 0n;
      const b = observedPos.get(inst) ?? 0n;
      if (a !== b) findings.push({ code: 'POSITION_MISMATCH', instrumentId: inst, expected: a.toString(), observed: b.toString() });
    }

    // 4. orders whose outcome is still unknown
    const stuck = await o.pool.query(
      `select client_order_id, status, (extract(epoch from (now() - updated_at)) * 1000)::float8 as age_ms
         from broker_order_intents where mode='BROKER_PAPER' and account_id=$1 and status in ('SUBMITTING','UNKNOWN')`,
      [o.accountId],
    );
    for (const r of stuck.rows) {
      if (r.age_ms > o.unresolvedOrderAfterMs) findings.push({ code: 'UNRESOLVED_ORDER', clientOrderId: r.client_order_id, status: r.status, ageMs: Math.floor(r.age_ms) });
    }

    const status: ReconcileResult['status'] = findings.length === 0 ? 'OK' : 'MISMATCH';
    const result: ReconcileResult = {
      status, findings, newExecutions: ing.inserted, halted: false,
      expected: { cashMinor: exp.cashMinor.toString(), positions: Object.fromEntries([...exp.positions].map(([k, v]) => [k, v.toString()])) },
      observed: { cashMinor: observedCash.toString(), positions: Object.fromEntries([...observedPos].map(([k, v]) => [k, v.toString()])) },
    };
    await o.pool.query(
      `insert into broker_reconciliations(mode, account_id, status, expected, observed, findings) values ('BROKER_PAPER', $1, $2, $3, $4, $5)`,
      [o.accountId, status, JSON.stringify(result.expected), JSON.stringify(result.observed), JSON.stringify(findings)],
    );

    // 5. freeze. The record above is already stored; if the halt call fails the caller must know.
    if (status === 'MISMATCH') {
      const reason = `RECONCILIATION ${findings.map((f) => f.code).join(',')} at ${new Date(now).toISOString()}`;
      try {
        await o.halt(reason);
        result.halted = true;
      } catch (e) {
        throw Object.assign(new Error(`HALT_FAILED: books and broker disagree and the gateway could not be told: ${(e as Error).message}`), { result });
      }
    }
    return result;
  }
}
