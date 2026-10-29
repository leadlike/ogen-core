import { randomUUID } from 'node:crypto';
import pg from 'pg';
import type { Action, MarketSnapshot, Mode, ModuleName, OrderSide, OrderStatus, PositionStatus, Quote, SecurityVerdict } from '../core/types';
import { TERMINAL_ORDER_STATUS } from '../core/types';
import type { ClosedTrade, LedgerEntry, LedgerKind } from '../core/accounting';

// int8 / numeric come back as numbers (values here stay far below 2^53)
pg.types.setTypeParser(20, (v) => Number(v));
pg.types.setTypeParser(1700, (v) => Number(v));

type Q = pg.Pool | pg.PoolClient;

export interface EventInput {
  correlationId: string;
  module: ModuleName;
  action: Action;
  mint?: string | null;
  pool?: string | null;
  snapshotId?: number | null;
  inputs?: unknown;
  provider?: string | null;
  dataTsMs?: number | null;
  strategyVersion: string;
  configHash: string;
  reasonCodes: string[];
  explanation: string;
  riskChecks?: unknown;
  orderId?: string | null;
  txSignature?: string | null;
}
export interface EventRow extends Required<Omit<EventInput, 'dataTsMs'>> {
  id: number;
  eventId: string;
  mode: Mode;
  ts: string;
  dataTs: string | null;
}

export interface OrderRow {
  id: string;
  mode: Mode;
  idempotencyKey: string;
  side: OrderSide;
  mint: string;
  pool: string | null;
  status: OrderStatus;
  attempt: number;
  notionalMicro: number;
  reservedMicro: number;
  intent: Record<string, unknown>;
  quote: Quote | null;
  requestId: string | null;
  txSignature: string | null;
  lastValidBlockHeight: number | null;
  expiresAt: string | null;
  error: string | null;
  correlationId: string;
  positionId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PositionRow {
  id: string;
  mode: Mode;
  mint: string;
  pool: string;
  symbol: string;
  decimals: number;
  status: PositionStatus;
  qtyAtomic: string;
  costMicro: number;
  entryFeeMicro: number;
  exitFeeMicro: number;
  proceedsMicro: number | null;
  entryPrice: number | null;
  entryLiquidityUsd: number | null;
  openedAt: string;
  closedAt: string | null;
  peakValueMicro: number;
  exitReason: string | null;
  correlationId: string;
  lastMark: unknown;
  unpriceableSince: string | null;
  nextExitAttemptAt: string | null;
  exitAttempts: number;
}

export interface CandidateRow {
  mode: Mode;
  mint: string;
  pool: string;
  symbol: string;
  firstSeen: string;
  lastSeen: string;
  stage: 'SCANNER' | 'SECURITY' | 'SIZING' | 'EXECUTION' | 'DONE';
  stageStatus: string;
  reasonCodes: string[];
  explanation: string;
  snapshotId: number | null;
  rankScore: number | null;
  detail: Record<string, unknown>;
  cooldownUntil: string | null;
  updatedAt: string;
}

export interface SystemState {
  mode: Mode;
  entriesPaused: boolean;
  killSwitch: boolean;
  liveArmed: boolean;
  startedAt: string | null;
  lastDataUpdate: string | null;
  providerHealth: Record<string, { ok: boolean; at: string; error?: string; latencyMs?: number }>;
  peakEquityMicro: number;
  dayStartDate: string | null;
  dayStartNlvMicro: number | null;
  dayStartContribMicro: number | null;
  consecutiveCostRejections: number;
  configHash: string | null;
  strategyVersion: string | null;
}

export interface ModuleStatusRow {
  module: ModuleName;
  status: 'OK' | 'DEGRADED' | 'ERROR' | 'PAUSED' | 'STOPPED';
  heartbeatAt: string;
  latencyMs: number | null;
  lastAction: string;
  lastError: string | null;
  errorCount: number;
  details: Record<string, unknown>;
}

const iso = (v: unknown): string | null => (v === null || v === undefined ? null : new Date(v as string).toISOString());

function orderFromRow(r: Record<string, any>): OrderRow {
  return {
    id: r.id,
    mode: r.mode,
    idempotencyKey: r.idempotency_key,
    side: r.side,
    mint: r.mint,
    pool: r.pool,
    status: r.status,
    attempt: r.attempt,
    notionalMicro: r.notional_micro,
    reservedMicro: r.reserved_micro,
    intent: r.intent,
    quote: r.quote,
    requestId: r.request_id,
    txSignature: r.tx_signature,
    lastValidBlockHeight: r.last_valid_block_height,
    expiresAt: iso(r.expires_at),
    error: r.error,
    correlationId: r.correlation_id,
    positionId: r.position_id,
    createdAt: iso(r.created_at) as string,
    updatedAt: iso(r.updated_at) as string,
  };
}

function positionFromRow(r: Record<string, any>): PositionRow {
  return {
    id: r.id,
    mode: r.mode,
    mint: r.mint,
    pool: r.pool,
    symbol: r.symbol,
    decimals: r.decimals,
    status: r.status,
    qtyAtomic: r.qty_atomic,
    costMicro: r.cost_micro,
    entryFeeMicro: r.entry_fee_micro,
    exitFeeMicro: r.exit_fee_micro,
    proceedsMicro: r.proceeds_micro,
    entryPrice: r.entry_price,
    entryLiquidityUsd: r.entry_liquidity_usd,
    openedAt: iso(r.opened_at) as string,
    closedAt: iso(r.closed_at),
    peakValueMicro: r.peak_value_micro,
    exitReason: r.exit_reason,
    correlationId: r.correlation_id,
    lastMark: r.last_mark,
    unpriceableSince: iso(r.unpriceable_since),
    nextExitAttemptAt: iso(r.next_exit_attempt_at),
    exitAttempts: r.exit_attempts,
  };
}

function candidateFromRow(r: Record<string, any>): CandidateRow {
  return {
    mode: r.mode,
    mint: r.mint,
    pool: r.pool,
    symbol: r.symbol,
    firstSeen: iso(r.first_seen) as string,
    lastSeen: iso(r.last_seen) as string,
    stage: r.stage,
    stageStatus: r.stage_status,
    reasonCodes: r.reason_codes,
    explanation: r.explanation,
    snapshotId: r.snapshot_id,
    rankScore: r.rank_score,
    detail: r.detail,
    cooldownUntil: iso(r.cooldown_until),
    updatedAt: iso(r.updated_at) as string,
  };
}

export class Store {
  constructor(
    readonly mode: Mode,
    private readonly q: Q,
    private readonly root: pg.Pool,
    private readonly inTx = false,
  ) {}

  static open(mode: Mode, pool: pg.Pool): Store {
    return new Store(mode, pool, pool);
  }

  /** Run `fn` inside one transaction; all writes commit or roll back together. */
  async tx<T>(fn: (s: Store) => Promise<T>): Promise<T> {
    if (this.inTx) return fn(this);
    const client = await this.root.connect();
    try {
      await client.query('begin');
      const out = await fn(new Store(this.mode, client, this.root, true));
      await client.query('commit');
      return out;
    } catch (e) {
      await client.query('rollback').catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }

  // -------------------------------------------------------------- events
  async appendEvent(e: EventInput): Promise<{ id: number; eventId: string }> {
    const r = await this.q.query(
      `insert into events (correlation_id, mode, module, action, mint, pool, snapshot_id, inputs, provider, data_ts,
         strategy_version, config_hash, reason_codes, explanation, risk_checks, order_id, tx_signature)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9, case when $10::bigint is null then null else to_timestamp($10::double precision/1000) end,
         $11,$12,$13,$14,$15,$16,$17)
       returning id, event_id`,
      [
        e.correlationId,
        this.mode,
        e.module,
        e.action,
        e.mint ?? null,
        e.pool ?? null,
        e.snapshotId ?? null,
        JSON.stringify(e.inputs ?? {}),
        e.provider ?? null,
        e.dataTsMs ?? null,
        e.strategyVersion,
        e.configHash,
        e.reasonCodes,
        e.explanation,
        JSON.stringify(e.riskChecks ?? []),
        e.orderId ?? null,
        e.txSignature ?? null,
      ],
    );
    return { id: r.rows[0].id, eventId: r.rows[0].event_id };
  }

  async listEvents(opts: { limit?: number; afterId?: number; mint?: string } = {}): Promise<EventRow[]> {
    const r = await this.q.query(
      `select * from events where mode=$1 and ($2::bigint is null or id > $2) and ($3::text is null or mint = $3)
       order by id desc limit $4`,
      [this.mode, opts.afterId ?? null, opts.mint ?? null, opts.limit ?? 200],
    );
    return r.rows.map((x) => ({
      id: x.id,
      eventId: x.event_id,
      correlationId: x.correlation_id,
      mode: x.mode,
      ts: iso(x.ts) as string,
      module: x.module,
      action: x.action,
      mint: x.mint,
      pool: x.pool,
      snapshotId: x.snapshot_id,
      inputs: x.inputs,
      provider: x.provider,
      dataTs: iso(x.data_ts),
      strategyVersion: x.strategy_version,
      configHash: x.config_hash,
      reasonCodes: x.reason_codes,
      explanation: x.explanation,
      riskChecks: x.risk_checks,
      orderId: x.order_id,
      txSignature: x.tx_signature,
    }));
  }

  async maxEventId(): Promise<number> {
    const r = await this.q.query('select coalesce(max(id),0) m from events where mode=$1', [this.mode]);
    return r.rows[0].m;
  }

  // -------------------------------------------------------------- snapshots
  async saveSnapshot(s: MarketSnapshot): Promise<number> {
    const r = await this.q.query(
      `insert into market_snapshots (mode, mint, pool, provider, origin, data_ts, payload)
       values ($1,$2,$3,$4,$5,to_timestamp($6::double precision/1000),$7) returning id`,
      [this.mode, s.mint, s.pool, s.provider, s.origin, s.fetchedAtMs, JSON.stringify(s)],
    );
    return r.rows[0].id;
  }
  async latestSnapshot(mint: string): Promise<{ id: number; snapshot: MarketSnapshot } | null> {
    const r = await this.q.query('select id, payload from market_snapshots where mode=$1 and mint=$2 order by id desc limit 1', [this.mode, mint]);
    return r.rows[0] ? { id: r.rows[0].id, snapshot: r.rows[0].payload } : null;
  }
  async getSnapshot(id: number): Promise<MarketSnapshot | null> {
    const r = await this.q.query('select payload from market_snapshots where mode=$1 and id=$2', [this.mode, id]);
    return r.rows[0]?.payload ?? null;
  }

  // -------------------------------------------------------------- candidates
  async upsertCandidate(c: { mint: string; pool: string; symbol: string; snapshotId: number }): Promise<void> {
    await this.q.query(
      `insert into candidates (mode, mint, pool, symbol, snapshot_id) values ($1,$2,$3,$4,$5)
       on conflict (mode, mint) do update set pool=excluded.pool, symbol=excluded.symbol,
         snapshot_id=excluded.snapshot_id, last_seen=now(), updated_at=now()`,
      [this.mode, c.mint, c.pool, c.symbol, c.snapshotId],
    );
  }
  async setCandidateStage(
    mint: string,
    p: { stage: CandidateRow['stage']; status: string; reasonCodes: string[]; explanation: string; rankScore?: number | null; detail?: unknown },
  ): Promise<void> {
    await this.q.query(
      `update candidates set stage=$3, stage_status=$4, reason_codes=$5, explanation=$6,
         rank_score=coalesce($7, rank_score), detail=detail || $8::jsonb, updated_at=now()
       where mode=$1 and mint=$2`,
      [this.mode, mint, p.stage, p.status, p.reasonCodes, p.explanation, p.rankScore ?? null, JSON.stringify(p.detail ?? {})],
    );
  }
  async setCooldown(mint: string, untilMs: number): Promise<void> {
    await this.q.query(`update candidates set cooldown_until=to_timestamp($3::double precision/1000) where mode=$1 and mint=$2`, [this.mode, mint, untilMs]);
  }
  async getCandidate(mint: string): Promise<CandidateRow | null> {
    const r = await this.q.query('select * from candidates where mode=$1 and mint=$2', [this.mode, mint]);
    return r.rows[0] ? candidateFromRow(r.rows[0]) : null;
  }
  async listCandidates(opts: { stage?: CandidateRow['stage']; status?: string; limit?: number } = {}): Promise<CandidateRow[]> {
    const r = await this.q.query(
      `select * from candidates where mode=$1 and ($2::text is null or stage=$2) and ($3::text is null or stage_status=$3)
       order by coalesce(rank_score,-1) desc, updated_at desc limit $4`,
      [this.mode, opts.stage ?? null, opts.status ?? null, opts.limit ?? 100],
    );
    return r.rows.map(candidateFromRow);
  }
  /** Candidates whose snapshot we still want refreshed (not done, seen recently). */
  async watchlistMints(limit = 30): Promise<string[]> {
    const r = await this.q.query(
      `select mint from candidates where mode=$1 and last_seen > now() - interval '6 hours'
       order by updated_at desc limit $2`,
      [this.mode, limit],
    );
    return r.rows.map((x) => x.mint);
  }

  // -------------------------------------------------------------- security
  async saveSecurity(v: SecurityVerdict, pool: string): Promise<number> {
    const r = await this.q.query(
      `insert into security_checks (mode, mint, pool, verdict, reason_codes, facts, evidence, checked_at)
       values ($1,$2,$3,$4,$5,$6,$7,to_timestamp($8::double precision/1000)) returning id`,
      [this.mode, v.evidence.mint, pool, v.status, v.reasonCodes, JSON.stringify(v.facts), JSON.stringify(v.evidence), v.checkedAtMs],
    );
    return r.rows[0].id;
  }
  async latestSecurity(mint: string): Promise<{ id: number; verdict: SecurityVerdict } | null> {
    const r = await this.q.query('select * from security_checks where mode=$1 and mint=$2 order by id desc limit 1', [this.mode, mint]);
    const x = r.rows[0];
    if (!x) return null;
    return {
      id: x.id,
      verdict: {
        status: x.verdict,
        reasonCodes: x.reason_codes,
        facts: x.facts,
        checkedAtMs: new Date(x.checked_at).getTime(),
        disclaimer: 'PASS means no critical risk was found in the evidence available at the timestamp shown. It is not a guarantee of safety.',
        evidence: x.evidence,
      },
    };
  }

  // -------------------------------------------------------------- orders
  /**
   * Persist an order intent. The (mode, idempotency_key) unique constraint guarantees that a retry,
   * a restart, or two concurrent workers can never create a second order for the same decision.
   */
  async createOrderIntent(o: {
    idempotencyKey: string;
    side: OrderSide;
    mint: string;
    pool?: string | null;
    notionalMicro: number;
    reservedMicro?: number;
    intent?: unknown;
    correlationId: string;
    positionId?: string | null;
  }): Promise<{ order: OrderRow; created: boolean }> {
    const ins = await this.q.query(
      `insert into orders (mode, idempotency_key, side, mint, pool, status, notional_micro, reserved_micro, intent, correlation_id, position_id)
       values ($1,$2,$3,$4,$5,'INTENT',$6,$7,$8,$9,$10)
       on conflict (mode, idempotency_key) do nothing returning *`,
      [this.mode, o.idempotencyKey, o.side, o.mint, o.pool ?? null, o.notionalMicro, o.reservedMicro ?? 0, JSON.stringify(o.intent ?? {}), o.correlationId, o.positionId ?? null],
    );
    if (ins.rows[0]) return { order: orderFromRow(ins.rows[0]), created: true };
    const ex = await this.q.query('select * from orders where mode=$1 and idempotency_key=$2', [this.mode, o.idempotencyKey]);
    return { order: orderFromRow(ex.rows[0]), created: false };
  }
  async getOrder(id: string): Promise<OrderRow | null> {
    const r = await this.q.query('select * from orders where mode=$1 and id=$2', [this.mode, id]);
    return r.rows[0] ? orderFromRow(r.rows[0]) : null;
  }
  async getOrderByKey(key: string): Promise<OrderRow | null> {
    const r = await this.q.query('select * from orders where mode=$1 and idempotency_key=$2', [this.mode, key]);
    return r.rows[0] ? orderFromRow(r.rows[0]) : null;
  }
  async updateOrder(
    id: string,
    patch: Partial<{
      status: OrderStatus;
      quote: Quote | null;
      requestId: string | null;
      txSignature: string | null;
      lastValidBlockHeight: number | null;
      expiresAtMs: number | null;
      error: string | null;
      attempt: number;
      reservedMicro: number;
      positionId: string | null;
    }>,
  ): Promise<OrderRow> {
    const sets: string[] = ['updated_at=now()'];
    const vals: unknown[] = [this.mode, id];
    const add = (col: string, v: unknown, expr = '$#') => {
      vals.push(v);
      sets.push(`${col}=${expr.replaceAll('$#', `$${vals.length}`)}`);
    };
    if (patch.status !== undefined) add('status', patch.status);
    if (patch.quote !== undefined) add('quote', patch.quote === null ? null : JSON.stringify(patch.quote), '$#::jsonb');
    if (patch.requestId !== undefined) add('request_id', patch.requestId);
    if (patch.txSignature !== undefined) add('tx_signature', patch.txSignature);
    if (patch.lastValidBlockHeight !== undefined) add('last_valid_block_height', patch.lastValidBlockHeight);
    if (patch.expiresAtMs !== undefined) add('expires_at', patch.expiresAtMs, 'to_timestamp($#::double precision/1000)');
    if (patch.error !== undefined) add('error', patch.error);
    if (patch.attempt !== undefined) add('attempt', patch.attempt);
    if (patch.reservedMicro !== undefined) add('reserved_micro', patch.reservedMicro);
    if (patch.positionId !== undefined) add('position_id', patch.positionId);
    const r = await this.q.query(`update orders set ${sets.join(', ')} where mode=$1 and id=$2 returning *`, vals);
    if (!r.rows[0]) throw new Error(`order ${id} not found in mode ${this.mode}`);
    return orderFromRow(r.rows[0]);
  }
  async listOrders(opts: { open?: boolean; statuses?: OrderStatus[]; limit?: number } = {}): Promise<OrderRow[]> {
    const statuses = opts.statuses ?? (opts.open ? (['INTENT', 'SUBMITTING', 'AMBIGUOUS'] as OrderStatus[]) : null);
    const r = await this.q.query(
      `select * from orders where mode=$1 and ($2::text[] is null or status = any($2)) order by created_at desc limit $3`,
      [this.mode, statuses, opts.limit ?? 200],
    );
    return r.rows.map(orderFromRow);
  }
  /** Cash reserved by orders that may still execute. */
  async reservedMicro(): Promise<number> {
    const r = await this.q.query(
      `select coalesce(sum(reserved_micro),0) s from orders where mode=$1 and status in ('INTENT','SUBMITTING','AMBIGUOUS')`,
      [this.mode],
    );
    return r.rows[0].s;
  }

  // -------------------------------------------------------------- positions
  async createPosition(p: {
    id?: string;
    mint: string;
    pool: string;
    symbol: string;
    decimals: number;
    qtyAtomic: string;
    costMicro: number;
    entryFeeMicro: number;
    entryPrice: number | null;
    entryLiquidityUsd: number | null;
    correlationId: string;
    /** engine-clock open time (DEMO runs on a fixture clock); defaults to the DB clock */
    openedAtMs?: number;
  }): Promise<PositionRow> {
    const r = await this.q.query(
      `insert into positions (id, mode, mint, pool, symbol, decimals, status, qty_atomic, cost_micro, entry_fee_micro,
         entry_price, entry_liquidity_usd, peak_value_micro, correlation_id, opened_at)
       values (coalesce($1, gen_random_uuid()),$2,$3,$4,$5,$6,'OPEN',$7,$8,$9,$10,$11,$8,$12,
         case when $13::double precision is null then now() else to_timestamp($13::double precision/1000) end) returning *`,
      [p.id ?? null, this.mode, p.mint, p.pool, p.symbol, p.decimals, p.qtyAtomic, p.costMicro, p.entryFeeMicro, p.entryPrice, p.entryLiquidityUsd, p.correlationId, p.openedAtMs ?? null],
    );
    return positionFromRow(r.rows[0]);
  }
  async getPosition(id: string): Promise<PositionRow | null> {
    const r = await this.q.query('select * from positions where mode=$1 and id=$2', [this.mode, id]);
    return r.rows[0] ? positionFromRow(r.rows[0]) : null;
  }
  async listPositions(statuses?: PositionStatus[], limit = 200): Promise<PositionRow[]> {
    const r = await this.q.query(
      `select * from positions where mode=$1 and ($2::text[] is null or status = any($2)) order by opened_at desc limit $3`,
      [this.mode, statuses ?? null, limit],
    );
    return r.rows.map(positionFromRow);
  }
  async openPositionForMint(mint: string): Promise<PositionRow | null> {
    const r = await this.q.query(`select * from positions where mode=$1 and mint=$2 and status <> 'CLOSED'`, [this.mode, mint]);
    return r.rows[0] ? positionFromRow(r.rows[0]) : null;
  }
  async updatePosition(
    id: string,
    patch: Partial<{
      status: PositionStatus;
      peakValueMicro: number;
      lastMark: unknown;
      unpriceableSinceMs: number | null;
      nextExitAttemptAtMs: number | null;
      exitAttempts: number;
      exitReason: string | null;
    }>,
  ): Promise<void> {
    const sets: string[] = [];
    const vals: unknown[] = [this.mode, id];
    const add = (col: string, v: unknown, expr = '$#') => {
      vals.push(v);
      sets.push(`${col}=${expr.replaceAll('$#', `$${vals.length}`)}`);
    };
    if (patch.status !== undefined) add('status', patch.status);
    if (patch.peakValueMicro !== undefined) add('peak_value_micro', patch.peakValueMicro);
    if (patch.lastMark !== undefined) add('last_mark', JSON.stringify(patch.lastMark), '$#::jsonb');
    if (patch.unpriceableSinceMs !== undefined) add('unpriceable_since', patch.unpriceableSinceMs, 'case when $#::double precision is null then null else to_timestamp($#::double precision/1000) end');
    if (patch.nextExitAttemptAtMs !== undefined) add('next_exit_attempt_at', patch.nextExitAttemptAtMs, 'case when $#::double precision is null then null else to_timestamp($#::double precision/1000) end');
    if (patch.exitAttempts !== undefined) add('exit_attempts', patch.exitAttempts);
    if (patch.exitReason !== undefined) add('exit_reason', patch.exitReason);
    if (!sets.length) return;
    await this.q.query(`update positions set ${sets.join(', ')} where mode=$1 and id=$2`, vals);
  }

  // -------------------------------------------------------------- ledger
  async appendLedger(e: { kind: LedgerKind; amountMicro: number; positionId?: string | null; orderId?: string | null; memo?: string; atMs?: number }): Promise<void> {
    await this.q.query(
      `insert into ledger (mode, kind, amount_micro, position_id, order_id, memo, ts)
       values ($1,$2,$3,$4,$5,$6, case when $7::double precision is null then now() else to_timestamp($7::double precision/1000) end)`,
      [this.mode, e.kind, e.amountMicro, e.positionId ?? null, e.orderId ?? null, e.memo ?? '', e.atMs ?? null],
    );
  }
  /** Idempotent initial funding; the unique partial index makes a restart a no-op. */
  async ensureInitialCapital(amountMicro: number): Promise<boolean> {
    const r = await this.q.query(
      `insert into ledger (mode, kind, amount_micro, memo) values ($1,'INIT',$2,'starting capital (simulated unless mode=LIVE)')
       on conflict (mode) where kind = 'INIT' do nothing`,
      [this.mode, amountMicro],
    );
    return (r.rowCount ?? 0) > 0;
  }
  async listLedger(): Promise<LedgerEntry[]> {
    const r = await this.q.query('select kind, amount_micro, ts, position_id from ledger where mode=$1 order by id', [this.mode]);
    return r.rows.map((x) => ({ kind: x.kind, amountMicro: x.amount_micro, tsMs: new Date(x.ts).getTime(), positionId: x.position_id }));
  }
  async spentBuyingSinceMs(sinceMs: number): Promise<number> {
    const r = await this.q.query(
      `select coalesce(-sum(amount_micro),0) s from ledger where mode=$1 and kind='BUY' and ts >= to_timestamp($2::double precision/1000)`,
      [this.mode, sinceMs],
    );
    return r.rows[0].s;
  }
  async closedTrades(limit = 500): Promise<ClosedTrade[]> {
    const r = await this.q.query(
      `select id, mint, cost_micro, proceeds_micro, entry_fee_micro, exit_fee_micro, opened_at, closed_at
       from positions where mode=$1 and status='CLOSED' order by closed_at desc limit $2`,
      [this.mode, limit],
    );
    return r.rows.map((x) => ({
      id: x.id,
      mint: x.mint,
      costMicro: x.cost_micro,
      proceedsMicro: x.proceeds_micro ?? 0,
      entryFeeMicro: x.entry_fee_micro,
      exitFeeMicro: x.exit_fee_micro,
      openedAtMs: new Date(x.opened_at).getTime(),
      closedAtMs: new Date(x.closed_at).getTime(),
    }));
  }

  // -------------------------------------------------------------- fills & settlement (atomic)
  async settleBuy(a: {
    orderId: string;
    correlationId: string;
    mint: string;
    pool: string;
    symbol: string;
    decimals: number;
    spentMicro: number;
    feeMicro: number;
    qtyAtomic: string;
    effectivePrice: number | null;
    entryLiquidityUsd: number | null;
    approximation: string;
    quote: Quote | null;
    txSignature?: string | null;
    atMs?: number;
  }): Promise<PositionRow> {
    return this.tx(async (s) => {
      const position = await s.createPosition({
        mint: a.mint,
        pool: a.pool,
        symbol: a.symbol,
        decimals: a.decimals,
        qtyAtomic: a.qtyAtomic,
        costMicro: a.spentMicro,
        entryFeeMicro: a.feeMicro,
        entryPrice: a.effectivePrice,
        entryLiquidityUsd: a.entryLiquidityUsd,
        correlationId: a.correlationId,
        openedAtMs: a.atMs,
      });
      await s.q.query(
        `insert into fills (mode, order_id, position_id, side, mint, in_amount_atomic, out_amount_atomic, notional_micro, fee_micro, effective_price, approximation, quote, tx_signature)
         values ($1,$2,$3,'BUY',$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [s.mode, a.orderId, position.id, a.mint, String(a.spentMicro), a.qtyAtomic, a.spentMicro, a.feeMicro, a.effectivePrice, a.approximation, JSON.stringify(a.quote), a.txSignature ?? null],
      );
      await s.appendLedger({ kind: 'BUY', amountMicro: -a.spentMicro, positionId: position.id, orderId: a.orderId, atMs: a.atMs });
      if (a.feeMicro > 0) await s.appendLedger({ kind: 'FEE', amountMicro: -a.feeMicro, positionId: position.id, orderId: a.orderId, memo: 'entry fees', atMs: a.atMs });
      await s.updateOrder(a.orderId, { status: 'CONFIRMED', positionId: position.id, reservedMicro: 0, error: null });
      return position;
    });
  }

  async settleSell(a: {
    orderId: string;
    positionId: string;
    proceedsMicro: number;
    feeMicro: number;
    qtyAtomicSold: string;
    effectivePrice: number | null;
    approximation: string;
    reason: string;
    quote: Quote | null;
    txSignature?: string | null;
    atMs?: number;
  }): Promise<ClosedTrade> {
    return this.tx(async (s) => {
      const p = await s.getPosition(a.positionId);
      if (!p) throw new Error('position not found');
      if (p.status === 'CLOSED') throw new Error('position already closed');
      const fill = await s.q.query(
        `insert into fills (mode, order_id, position_id, side, mint, in_amount_atomic, out_amount_atomic, notional_micro, fee_micro, effective_price, approximation, quote, tx_signature)
         values ($1,$2,$3,'SELL',$4,$5,$6,$7,$8,$9,$10,$11,$12) on conflict (mode, order_id) do nothing returning id`,
        [s.mode, a.orderId, a.positionId, p.mint, a.qtyAtomicSold, String(a.proceedsMicro), a.proceedsMicro, a.feeMicro, a.effectivePrice, a.approximation, JSON.stringify(a.quote), a.txSignature ?? null],
      );
      if (fill.rowCount === 0) throw new Error('fill already recorded for this order');
      await s.appendLedger({ kind: 'SELL', amountMicro: a.proceedsMicro, positionId: p.id, orderId: a.orderId, atMs: a.atMs });
      if (a.feeMicro > 0) await s.appendLedger({ kind: 'FEE', amountMicro: -a.feeMicro, positionId: p.id, orderId: a.orderId, memo: 'exit fees', atMs: a.atMs });
      await s.q.query(
        `update positions set status='CLOSED', closed_at=case when $6::double precision is null then now() else to_timestamp($6::double precision/1000) end,
           proceeds_micro=$3, exit_fee_micro=$4, exit_reason=$5 where mode=$1 and id=$2`,
        [s.mode, p.id, a.proceedsMicro, a.feeMicro, a.reason, a.atMs ?? null],
      );
      await s.updateOrder(a.orderId, { status: 'CONFIRMED', reservedMicro: 0, error: null });
      return {
        id: p.id,
        mint: p.mint,
        costMicro: p.costMicro,
        proceedsMicro: a.proceedsMicro,
        entryFeeMicro: p.entryFeeMicro,
        exitFeeMicro: a.feeMicro,
        openedAtMs: new Date(p.openedAt).getTime(),
        closedAtMs: a.atMs ?? Date.now(),
      };
    });
  }

  /** A failed/expired transaction still costs a network fee: record it as an unattributed fee. */
  async recordFailedOrderFee(orderId: string, feeMicro: number, memo: string, atMs?: number): Promise<void> {
    if (feeMicro > 0) await this.appendLedger({ kind: 'FEE', amountMicro: -feeMicro, orderId, memo, atMs });
  }

  // -------------------------------------------------------------- equity snapshots
  async saveEquity(e: {
    nlvExecutableMicro: number;
    nlvQuotedMicro: number;
    cashMicro: number;
    netContributedMicro: number;
    openPositions: number;
    staleCount: number;
    unpriceableCount: number;
  }): Promise<void> {
    await this.q.query(
      `insert into equity_snapshots (mode, nlv_executable_micro, nlv_quoted_micro, cash_micro, net_contributed_micro, open_positions, stale_count, unpriceable_count)
       values ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [this.mode, e.nlvExecutableMicro, e.nlvQuotedMicro, e.cashMicro, e.netContributedMicro, e.openPositions, e.staleCount, e.unpriceableCount],
    );
  }
  async listEquity(limit = 500): Promise<Array<{ tsMs: number; nlvExecutableMicro: number; nlvQuotedMicro: number; cashMicro: number; netContributedMicro: number }>> {
    const r = await this.q.query(
      `select ts, nlv_executable_micro, nlv_quoted_micro, cash_micro, net_contributed_micro from (
         select * from equity_snapshots where mode=$1 order by id desc limit $2) t order by ts asc`,
      [this.mode, limit],
    );
    return r.rows.map((x) => ({
      tsMs: new Date(x.ts).getTime(),
      nlvExecutableMicro: x.nlv_executable_micro,
      nlvQuotedMicro: x.nlv_quoted_micro,
      cashMicro: x.cash_micro,
      netContributedMicro: x.net_contributed_micro,
    }));
  }

  // -------------------------------------------------------------- system state
  async ensureSystemState(): Promise<SystemState> {
    await this.q.query('insert into system_state (mode) values ($1) on conflict (mode) do nothing', [this.mode]);
    return (await this.getSystemState()) as SystemState;
  }
  async getSystemState(): Promise<SystemState | null> {
    const r = await this.q.query("select *, to_char(day_start_date, 'YYYY-MM-DD') as day_start_txt from system_state where mode=$1", [this.mode]);
    const x = r.rows[0];
    if (!x) return null;
    return {
      mode: x.mode,
      entriesPaused: x.entries_paused,
      killSwitch: x.kill_switch,
      liveArmed: x.live_armed,
      startedAt: iso(x.started_at),
      lastDataUpdate: iso(x.last_data_update),
      providerHealth: x.provider_health,
      peakEquityMicro: x.peak_equity_micro,
      dayStartDate: x.day_start_txt ?? null,
      dayStartNlvMicro: x.day_start_nlv_micro,
      dayStartContribMicro: x.day_start_contrib_micro,
      consecutiveCostRejections: x.consecutive_cost_rejections,
      configHash: x.config_hash,
      strategyVersion: x.strategy_version,
    };
  }
  async patchSystemState(p: Partial<Record<keyof Omit<SystemState, 'mode' | 'providerHealth'>, unknown>> & { providerHealth?: SystemState['providerHealth'] }): Promise<void> {
    const colMap: Record<string, string> = {
      entriesPaused: 'entries_paused',
      killSwitch: 'kill_switch',
      liveArmed: 'live_armed',
      startedAt: 'started_at',
      lastDataUpdate: 'last_data_update',
      providerHealth: 'provider_health',
      peakEquityMicro: 'peak_equity_micro',
      dayStartDate: 'day_start_date',
      dayStartNlvMicro: 'day_start_nlv_micro',
      dayStartContribMicro: 'day_start_contrib_micro',
      consecutiveCostRejections: 'consecutive_cost_rejections',
      configHash: 'config_hash',
      strategyVersion: 'strategy_version',
    };
    const sets: string[] = ['updated_at=now()'];
    const vals: unknown[] = [this.mode];
    for (const [k, v] of Object.entries(p)) {
      const col = colMap[k];
      if (!col) continue;
      vals.push(k === 'providerHealth' ? JSON.stringify(v) : v);
      sets.push(`${col}=$${vals.length}`);
    }
    await this.q.query(`update system_state set ${sets.join(', ')} where mode=$1`, vals);
  }

  // -------------------------------------------------------------- module status
  async heartbeat(m: { module: ModuleName; status: ModuleStatusRow['status']; latencyMs: number | null; lastAction: string; error?: string | null; details?: unknown; bumpError?: boolean }): Promise<void> {
    await this.q.query(
      `insert into module_status (mode, module, status, heartbeat_at, latency_ms, last_action, last_error, error_count, details)
       values ($1,$2,$3,now(),$4,$5,$6,$7,$8)
       on conflict (mode, module) do update set status=excluded.status, heartbeat_at=now(), latency_ms=excluded.latency_ms,
         last_action=excluded.last_action, last_error=coalesce(excluded.last_error, case when excluded.status='OK' then null else module_status.last_error end),
         error_count=module_status.error_count + $7, details=excluded.details`,
      [this.mode, m.module, m.status, m.latencyMs, m.lastAction, m.error ?? null, m.bumpError ? 1 : 0, JSON.stringify(m.details ?? {})],
    );
  }
  async listModuleStatus(): Promise<ModuleStatusRow[]> {
    const r = await this.q.query('select * from module_status where mode=$1 order by module', [this.mode]);
    return r.rows.map((x) => ({
      module: x.module,
      status: x.status,
      heartbeatAt: iso(x.heartbeat_at) as string,
      latencyMs: x.latency_ms,
      lastAction: x.last_action,
      lastError: x.last_error,
      errorCount: x.error_count,
      details: x.details,
    }));
  }

  // -------------------------------------------------------------- breakers
  async tripBreaker(code: string, detail: unknown): Promise<boolean> {
    const r = await this.q.query(
      `insert into breakers (mode, code, detail) values ($1,$2,$3) on conflict (mode, code) where cleared_at is null do nothing`,
      [this.mode, code, JSON.stringify(detail ?? {})],
    );
    return (r.rowCount ?? 0) > 0;
  }
  async clearBreaker(code: string, by: string): Promise<boolean> {
    const r = await this.q.query(`update breakers set cleared_at=now(), cleared_by=$3 where mode=$1 and code=$2 and cleared_at is null`, [this.mode, code, by]);
    return (r.rowCount ?? 0) > 0;
  }
  async activeBreakers(): Promise<Array<{ code: string; trippedAt: string; detail: Record<string, unknown> }>> {
    const r = await this.q.query('select code, tripped_at, detail from breakers where mode=$1 and cleared_at is null order by tripped_at', [this.mode]);
    return r.rows.map((x) => ({ code: x.code, trippedAt: iso(x.tripped_at) as string, detail: x.detail }));
  }

  // -------------------------------------------------------------- control commands
  async enqueueCommand(command: string, payload: unknown = {}): Promise<number> {
    const r = await this.q.query('insert into control_commands (mode, command, payload) values ($1,$2,$3) returning id', [this.mode, command, JSON.stringify(payload)]);
    return r.rows[0].id;
  }
  /** Claim pending commands atomically (safe with several consumers). */
  async claimCommands(): Promise<Array<{ id: number; command: string; payload: Record<string, unknown> }>> {
    const r = await this.q.query(
      `update control_commands set processed_at=now() where id in (
         select id from control_commands where mode=$1 and processed_at is null order by id for update skip locked)
       returning id, command, payload`,
      [this.mode],
    );
    return r.rows.sort((a, b) => a.id - b.id);
  }
  async completeCommand(id: number, result: unknown): Promise<void> {
    await this.q.query('update control_commands set result=$2 where id=$1 and mode=$3', [id, JSON.stringify(result), this.mode]);
  }
  async recentCommands(limit = 20): Promise<Array<{ id: number; command: string; requestedAt: string; processedAt: string | null; result: unknown }>> {
    const r = await this.q.query('select * from control_commands where mode=$1 order by id desc limit $2', [this.mode, limit]);
    return r.rows.map((x) => ({ id: x.id, command: x.command, requestedAt: iso(x.requested_at) as string, processedAt: iso(x.processed_at), result: x.result }));
  }

  // -------------------------------------------------------------- consistency (used by reconciliation)
  /**
   * Cross-check the append-only ledger against positions, fills and orders. Returns human-readable
   * discrepancies; an empty list means the books agree internally (it says nothing about the chain).
   */
  async internalConsistency(): Promise<string[]> {
    const out: string[] = [];
    const pos = await this.q.query(
      `select p.id, p.symbol, p.status, p.cost_micro, p.entry_fee_micro, p.exit_fee_micro, p.proceeds_micro,
         coalesce(-sum(l.amount_micro) filter (where l.kind='BUY'),0) buy_l,
         coalesce(sum(l.amount_micro) filter (where l.kind='SELL'),0) sell_l,
         coalesce(-sum(l.amount_micro) filter (where l.kind='FEE'),0) fee_l
       from positions p left join ledger l on l.mode=p.mode and l.position_id=p.id
       where p.mode=$1 group by p.mode, p.id, p.symbol, p.status, p.cost_micro, p.entry_fee_micro, p.exit_fee_micro, p.proceeds_micro`,
      [this.mode],
    );
    for (const x of pos.rows) {
      if (Number(x.buy_l) !== Number(x.cost_micro)) out.push(`position ${x.symbol} ${x.id}: ledger BUY ${x.buy_l} != cost ${x.cost_micro}`);
      if (x.status === 'CLOSED' && Number(x.sell_l) !== Number(x.proceeds_micro ?? 0)) out.push(`position ${x.symbol} ${x.id}: ledger SELL ${x.sell_l} != proceeds ${x.proceeds_micro}`);
      if (x.status !== 'CLOSED' && Number(x.sell_l) !== 0) out.push(`position ${x.symbol} ${x.id}: open but has SELL ledger ${x.sell_l}`);
      const fees = Number(x.entry_fee_micro) + (x.status === 'CLOSED' ? Number(x.exit_fee_micro) : 0);
      if (Number(x.fee_l) !== fees) out.push(`position ${x.symbol} ${x.id}: ledger FEE ${x.fee_l} != recorded fees ${fees}`);
    }
    const noFill = await this.q.query(
      `select o.id from orders o where o.mode=$1 and o.status='CONFIRMED' and not exists (select 1 from fills f where f.mode=o.mode and f.order_id=o.id)`,
      [this.mode],
    );
    for (const x of noFill.rows) out.push(`order ${x.id} is CONFIRMED but has no fill`);
    const orphan = await this.q.query(
      `select f.order_id from fills f join orders o on o.mode=f.mode and o.id=f.order_id where f.mode=$1 and o.status <> 'CONFIRMED'`,
      [this.mode],
    );
    for (const x of orphan.rows) out.push(`fill for order ${x.order_id} but order is not CONFIRMED`);
    return out;
  }
  /** The BUY order that opened a position (carries intent: token program, decimals, ...). */
  async getBuyOrderForPosition(positionId: string): Promise<OrderRow | null> {
    const r = await this.q.query(`select * from orders where mode=$1 and position_id=$2 and side='BUY' and status='CONFIRMED' order by created_at limit 1`, [this.mode, positionId]);
    return r.rows[0] ? orderFromRow(r.rows[0]) : null;
  }
  async listFills(limit = 200): Promise<Array<{ orderId: string; positionId: string; side: string; mint: string; notionalMicro: number; feeMicro: number; effectivePrice: number | null; approximation: string; txSignature: string | null; tsMs: number }>> {
    const r = await this.q.query('select * from fills where mode=$1 order by id desc limit $2', [this.mode, limit]);
    return r.rows.map((x) => ({
      orderId: x.order_id,
      positionId: x.position_id,
      side: x.side,
      mint: x.mint,
      notionalMicro: Number(x.notional_micro),
      feeMicro: Number(x.fee_micro),
      effectivePrice: x.effective_price,
      approximation: x.approximation,
      txSignature: x.tx_signature,
      tsMs: new Date(x.ts).getTime(),
    }));
  }

  // -------------------------------------------------------------- AI commentary (kept apart from evidence)
  async saveCommentary(c: { kind: string; refEventId?: string | null; provider: string; model: string; text: string }): Promise<void> {
    await this.q.query('insert into ai_commentary (mode, kind, ref_event_id, provider, model, text) values ($1,$2,$3,$4,$5,$6)', [this.mode, c.kind, c.refEventId ?? null, c.provider, c.model, c.text]);
  }
  async listCommentary(limit = 20): Promise<Array<{ kind: string; provider: string; model: string; text: string; createdAt: string }>> {
    const r = await this.q.query('select * from ai_commentary where mode=$1 order by id desc limit $2', [this.mode, limit]);
    return r.rows.map((x) => ({ kind: x.kind, provider: x.provider, model: x.model, text: x.text, createdAt: iso(x.created_at) as string }));
  }
}

export const newCorrelationId = (): string => randomUUID();
export const isTerminal = (s: OrderStatus): boolean => TERMINAL_ORDER_STATUS.includes(s);

export function createPool(url: string, max = 10): pg.Pool {
  return new pg.Pool({ connectionString: url, max });
}
