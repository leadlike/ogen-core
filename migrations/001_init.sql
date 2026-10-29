-- ogen schema v1
-- Every table carries `mode` (DEMO | PAPER | LIVE). Rows from one mode can never reference
-- rows of another: cross-table references are COMPOSITE foreign keys (mode, id).

create table if not exists schema_migrations (
  version text primary key,
  applied_at timestamptz not null default now()
);

create domain run_mode as text check (value in ('DEMO','PAPER','LIVE'));

-- ---------------------------------------------------------------- events (append-only)
create table events (
  id            bigserial primary key,
  event_id      uuid not null default gen_random_uuid() unique,
  correlation_id uuid not null,
  mode          run_mode not null,
  ts            timestamptz not null default now(),
  module        text not null,
  action        text not null check (action in ('WATCH','WAIT','REJECT','ENTER','EXIT','ERROR','HALT')),
  mint          text,
  pool          text,
  snapshot_id   bigint,
  inputs        jsonb not null default '{}'::jsonb,
  provider      text,
  data_ts       timestamptz,
  strategy_version text not null,
  config_hash   text not null,
  reason_codes  text[] not null default '{}',
  explanation   text not null,
  risk_checks   jsonb not null default '[]'::jsonb,
  order_id      uuid,
  tx_signature  text
);
create index events_mode_id on events (mode, id desc);
create index events_mode_mint on events (mode, mint, id desc);
create index events_corr on events (correlation_id);

create function forbid_mutation() returns trigger language plpgsql as $$
begin
  raise exception '% on % is forbidden: table is append-only', tg_op, tg_table_name using errcode = 'P0001';
end $$;

create trigger events_append_only before update or delete on events
  for each row execute function forbid_mutation();
create trigger events_no_truncate before truncate on events
  for each statement execute function forbid_mutation();

-- ---------------------------------------------------------------- market snapshots (durable input references)
create table market_snapshots (
  id          bigserial primary key,
  mode        run_mode not null,
  mint        text not null,
  pool        text not null,
  provider    text not null,
  origin      text not null check (origin in ('live','fixture')),
  data_ts     timestamptz not null,
  payload     jsonb not null,
  created_at  timestamptz not null default now(),
  -- DEMO may only hold fixtures; PAPER/LIVE may only hold live data
  constraint snapshot_origin_matches_mode check (
    (mode = 'DEMO' and origin = 'fixture') or (mode <> 'DEMO' and origin = 'live')
  )
);
create index snapshots_mode_mint on market_snapshots (mode, mint, id desc);

-- ---------------------------------------------------------------- candidates / pipeline
create table candidates (
  mode        run_mode not null,
  mint        text not null,
  pool        text not null,
  symbol      text not null default '',
  first_seen  timestamptz not null default now(),
  last_seen   timestamptz not null default now(),
  stage       text not null default 'SCANNER'
                check (stage in ('SCANNER','SECURITY','SIZING','EXECUTION','DONE')),
  stage_status text not null default 'PENDING',
  reason_codes text[] not null default '{}',
  explanation text not null default '',
  snapshot_id bigint,
  rank_score  double precision,
  detail      jsonb not null default '{}'::jsonb,
  cooldown_until timestamptz,
  updated_at  timestamptz not null default now(),
  primary key (mode, mint)
);
create index candidates_stage on candidates (mode, stage, stage_status);

create table security_checks (
  id          bigserial primary key,
  mode        run_mode not null,
  mint        text not null,
  pool        text not null,
  verdict     text not null check (verdict in ('PASS','REJECT','UNKNOWN')),
  reason_codes text[] not null,
  facts       jsonb not null,
  evidence    jsonb not null,
  checked_at  timestamptz not null
);
create index security_mode_mint on security_checks (mode, mint, id desc);

-- ---------------------------------------------------------------- orders / fills / positions
create table orders (
  id              uuid not null default gen_random_uuid(),
  mode            run_mode not null,
  idempotency_key text not null,
  side            text not null check (side in ('BUY','SELL')),
  mint            text not null,
  pool            text,
  status          text not null check (status in
                    ('INTENT','SUBMITTING','AMBIGUOUS','CONFIRMED','FAILED','EXPIRED','CANCELLED')),
  attempt         int not null default 1,
  notional_micro  bigint not null,
  reserved_micro  bigint not null default 0,
  intent          jsonb not null default '{}'::jsonb,
  quote           jsonb,
  request_id      text,
  tx_signature    text,
  last_valid_block_height bigint,
  expires_at      timestamptz,
  error           text,
  correlation_id  uuid not null,
  position_id     uuid,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  primary key (mode, id),
  unique (mode, idempotency_key)
);
create index orders_open on orders (mode, status);
create unique index orders_signature on orders (mode, tx_signature) where tx_signature is not null;

create table positions (
  id              uuid not null default gen_random_uuid(),
  mode            run_mode not null,
  mint            text not null,
  pool            text not null,
  symbol          text not null default '',
  decimals        int not null,
  status          text not null check (status in ('OPEN','CLOSING','CLOSED','UNSELLABLE')),
  qty_atomic      text not null,
  cost_micro      bigint not null,
  entry_fee_micro bigint not null default 0,
  exit_fee_micro  bigint not null default 0,
  proceeds_micro  bigint,
  entry_price     double precision,
  entry_liquidity_usd double precision,
  opened_at       timestamptz not null default now(),
  closed_at       timestamptz,
  peak_value_micro bigint not null default 0,
  exit_reason     text,
  correlation_id  uuid not null,
  last_mark       jsonb,
  unpriceable_since timestamptz,
  next_exit_attempt_at timestamptz,
  exit_attempts   int not null default 0,
  primary key (mode, id)
);
-- at most one live (non-closed) position per mint and mode
create unique index positions_one_open_per_mint on positions (mode, mint) where status <> 'CLOSED';
create index positions_status on positions (mode, status);

alter table orders add constraint orders_position_fk
  foreign key (mode, position_id) references positions (mode, id) deferrable initially deferred;

create table fills (
  id              bigserial primary key,
  mode            run_mode not null,
  order_id        uuid not null,
  position_id     uuid not null,
  side            text not null check (side in ('BUY','SELL')),
  mint            text not null,
  in_amount_atomic  text not null,
  out_amount_atomic text not null,
  notional_micro  bigint not null,
  fee_micro       bigint not null default 0,
  effective_price double precision,
  approximation   text not null,
  quote           jsonb,
  tx_signature    text,
  ts              timestamptz not null default now(),
  foreign key (mode, order_id) references orders (mode, id),
  foreign key (mode, position_id) references positions (mode, id) deferrable initially deferred,
  unique (mode, order_id)
);

-- ---------------------------------------------------------------- ledger (append-only; cash is derived from it)
create table ledger (
  id          bigserial primary key,
  mode        run_mode not null,
  ts          timestamptz not null default now(),
  kind        text not null check (kind in ('INIT','DEPOSIT','WITHDRAWAL','BUY','SELL','FEE')),
  amount_micro bigint not null,
  position_id uuid,
  order_id    uuid,
  memo        text not null default '',
  foreign key (mode, position_id) references positions (mode, id) deferrable initially deferred,
  foreign key (mode, order_id) references orders (mode, id) deferrable initially deferred
);
create unique index ledger_one_init on ledger (mode) where kind = 'INIT';
create index ledger_mode on ledger (mode, id);
create trigger ledger_append_only before update or delete on ledger
  for each row execute function forbid_mutation();
create trigger ledger_no_truncate before truncate on ledger
  for each statement execute function forbid_mutation();

create table equity_snapshots (
  id            bigserial primary key,
  mode          run_mode not null,
  ts            timestamptz not null default now(),
  nlv_executable_micro bigint not null,
  nlv_quoted_micro bigint not null,
  cash_micro    bigint not null,
  net_contributed_micro bigint not null,
  open_positions int not null,
  stale_count   int not null default 0,
  unpriceable_count int not null default 0
);
create index equity_mode_ts on equity_snapshots (mode, id desc);

-- ---------------------------------------------------------------- operational state
create table module_status (
  mode          run_mode not null,
  module        text not null,
  status        text not null check (status in ('OK','DEGRADED','ERROR','PAUSED','STOPPED')),
  heartbeat_at  timestamptz not null default now(),
  latency_ms    integer,
  last_action   text not null default '',
  last_error    text,
  error_count   integer not null default 0,
  details       jsonb not null default '{}'::jsonb,
  primary key (mode, module)
);

create table system_state (
  mode              run_mode primary key,
  entries_paused    boolean not null default false,
  kill_switch       boolean not null default false,
  live_armed        boolean not null default false,
  started_at        timestamptz,
  last_data_update  timestamptz,
  provider_health   jsonb not null default '{}'::jsonb,
  peak_equity_micro bigint not null default 0,
  day_start_date    date,
  day_start_nlv_micro bigint,
  day_start_contrib_micro bigint,
  consecutive_cost_rejections integer not null default 0,
  config_hash       text,
  strategy_version  text,
  updated_at        timestamptz not null default now()
);

create table breakers (
  id          bigserial primary key,
  mode        run_mode not null,
  code        text not null,
  tripped_at  timestamptz not null default now(),
  cleared_at  timestamptz,
  cleared_by  text,
  detail      jsonb not null default '{}'::jsonb
);
create unique index breakers_one_active on breakers (mode, code) where cleared_at is null;

create table control_commands (
  id           bigserial primary key,
  mode         run_mode not null,
  command      text not null,
  payload      jsonb not null default '{}'::jsonb,
  requested_at timestamptz not null default now(),
  processed_at timestamptz,
  result       jsonb
);
create index control_pending on control_commands (mode, id) where processed_at is null;

-- AI commentary is kept strictly apart from decision evidence
create table ai_commentary (
  id          bigserial primary key,
  mode        run_mode not null,
  kind        text not null,
  ref_event_id uuid,
  provider    text not null,
  model       text not null,
  text        text not null,
  created_at  timestamptz not null default now()
);
