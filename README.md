# ogen-core

A small, strict **risk gateway** and **Interactive Brokers (IBKR) paper adapter** for automated trading of a very small account.
Paper trading only. See `DISCLAIMER.md` before anything else.

The idea: a strategy proposes orders, but a separate process decides whether they may exist. The gateway keeps its own view of the
account, its own persisted state, and refuses anything outside the limits, whatever the caller believes.

## What is here
- `src/gateway/`: the risk gateway (HTTP process boundary, worker and admin tokens, mutex, persisted reservations, breakers for
  daily loss, sticky drawdown and reconciliation, spread filter, symbol allowlist, NYSE calendar from rules, cumulative open-risk cap,
  single-instance lock with heartbeat takeover and fencing).
- `src/broker/`: executor (claim before send; UNKNOWN is never resubmitted blindly), reconciliation against the broker,
  append-only books, and the IBKR adapter (`@stoqey/ib` behind a small `IbClient` interface).
- `tests/`: a scripted fake TWS plus tests. Database tests run on a real PostgreSQL.
- `scripts/verify-ibkr-paper.ts`: a full round trip on a paper account (places real paper orders; needs explicit confirmation).
- `docs/IBKR_PAPER.md`: conventions, what is proven, and what is not.

## Money
Integer minor units (cents) as strings/bigint. Limits are exact integer arithmetic.

## Run the tests
```
npm ci
# PostgreSQL on 127.0.0.1:5433, database ogen_test (override with TEST_DATABASE_URL; see tests/dbhelper.ts)
npm run typecheck && npm test
```

## Status
Early. Written and tested against a fake; the real-paper assumptions are still being verified. Issues and review are welcome.
