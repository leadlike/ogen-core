-- Books for BROKER_PAPER: what the broker says it executed, kept append-only, and every
-- comparison of those books against the broker's own cash and positions.

-- Starting cash, set once per account. A different second value is an error, never an update.
create table broker_baselines (
  mode       run_mode not null check (mode = 'BROKER_PAPER'),
  account_id text not null,
  cash_minor bigint not null check (cash_minor >= 0),
  note       text not null,
  at         timestamptz not null default now(),
  primary key (mode, account_id),
  foreign key (mode, account_id) references broker_accounts (mode, account_id)
);

create table broker_executions (
  mode            run_mode not null check (mode = 'BROKER_PAPER'),
  account_id      text not null,
  execution_id    text not null check (length(execution_id) between 1 and 128),
  client_order_id text,
  instrument_id   text not null,
  side            text not null check (side in ('BUY','SELL')),
  quantity        bigint not null check (quantity > 0),
  price_minor     bigint not null check (price_minor > 0),
  fee_minor       bigint not null check (fee_minor >= 0),
  executed_at     timestamptz not null,
  ingested_at     timestamptz not null default now(),
  primary key (mode, account_id, execution_id),
  foreign key (mode, account_id) references broker_accounts (mode, account_id)
);
create index broker_executions_time on broker_executions (mode, account_id, executed_at);

-- An operator's decision that a foreign execution (a manual trade in the account) is understood and accepted.
create table broker_execution_acks (
  mode         run_mode not null check (mode = 'BROKER_PAPER'),
  account_id   text not null,
  execution_id text not null,
  note         text not null check (length(note) >= 3),
  at           timestamptz not null default now(),
  primary key (mode, account_id, execution_id),
  foreign key (mode, account_id, execution_id) references broker_executions (mode, account_id, execution_id)
);

create table broker_reconciliations (
  id         bigserial primary key,
  mode       run_mode not null check (mode = 'BROKER_PAPER'),
  account_id text not null,
  at         timestamptz not null default now(),
  status     text not null check (status in ('OK','MISMATCH')),
  expected   jsonb not null,
  observed   jsonb not null,
  findings   jsonb not null default '[]'::jsonb,
  foreign key (mode, account_id) references broker_accounts (mode, account_id)
);
create index broker_reconciliations_recent on broker_reconciliations (mode, account_id, id desc);

create trigger broker_baselines_append_only before update or delete on broker_baselines
  for each row execute function forbid_mutation();
create trigger broker_executions_append_only before update or delete on broker_executions
  for each row execute function forbid_mutation();
create trigger broker_reconciliations_append_only before update or delete on broker_reconciliations
  for each row execute function forbid_mutation();
create trigger broker_acks_append_only before update or delete on broker_execution_acks
  for each row execute function forbid_mutation();
create trigger broker_acks_no_truncate before truncate on broker_execution_acks
  for each statement execute function forbid_mutation();
create trigger broker_baselines_no_truncate before truncate on broker_baselines
  for each statement execute function forbid_mutation();
create trigger broker_executions_no_truncate before truncate on broker_executions
  for each statement execute function forbid_mutation();
create trigger broker_reconciliations_no_truncate before truncate on broker_reconciliations
  for each statement execute function forbid_mutation();
