-- BROKER_PAPER: orders sent to a broker's own simulation account, using real market data.
-- Separate from PAPER (internal simulator) and LIVE (real money). Nothing here moves money.

alter domain run_mode drop constraint run_mode_check;
alter domain run_mode add constraint run_mode_check
  check (value in ('DEMO','PAPER','BROKER_PAPER','LIVE'));
-- snapshot_origin_matches_mode (001) already says: not DEMO => origin 'live', so BROKER_PAPER
-- rows can only carry real market data. Cash/equity stay derived from the append-only ledger.

-- Static trading constraints per broker instrument. No defaults: a missing value must be filled
-- from the broker, never assumed.
create table broker_instruments (
  broker_name        text not null,
  symbol             text not null,
  currency           char(3) not null,
  min_notional_minor bigint not null check (min_notional_minor >= 0),
  tick_size_minor    bigint not null check (tick_size_minor > 0),
  allow_fractional   boolean not null,
  is_tradable        boolean not null,
  updated_at         timestamptz not null default now(),
  primary key (broker_name, symbol)
);

create table broker_accounts (
  mode       run_mode not null check (mode = 'BROKER_PAPER'),
  account_id text not null check (length(account_id) between 1 and 128),
  currency   char(3) not null,
  created_at timestamptz not null default now(),
  primary key (mode, account_id)
);

create table broker_order_intents (
  mode            run_mode not null check (mode = 'BROKER_PAPER'),
  account_id      text not null,
  client_order_id text not null check (length(client_order_id) between 1 and 128),
  kind            text not null check (kind in ('BUY_BRACKET','CLOSE')),
  fingerprint     char(64) not null,
  intent          jsonb not null,
  status          text not null check (status in
                    ('SUBMITTING','UNKNOWN','ACCEPTED','PART_FILLED','FILLED','CANCELED','REJECTED')),
  broker_order    jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  primary key (mode, account_id, client_order_id),
  foreign key (mode, account_id) references broker_accounts (mode, account_id)
);
create index broker_intents_open on broker_order_intents (mode, status);

-- every state change, append-only
create table broker_order_events (
  id              bigserial primary key,
  mode            run_mode not null,
  account_id      text not null,
  client_order_id text not null,
  from_status     text,
  to_status       text not null,
  broker_order    jsonb,
  at              timestamptz not null default now(),
  foreign key (mode, account_id, client_order_id)
    references broker_order_intents (mode, account_id, client_order_id)
);
create index broker_events_order on broker_order_events (mode, account_id, client_order_id, id);
create trigger broker_events_append_only before update or delete on broker_order_events
  for each row execute function forbid_mutation();
create trigger broker_events_no_truncate before truncate on broker_order_events
  for each statement execute function forbid_mutation();
