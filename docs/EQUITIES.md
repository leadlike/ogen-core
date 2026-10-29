# Equities worker (paper) — `npm run equities`

Process: `src/equities/main.ts` → `Runner.tick()` every `TICK_MS` (30 s by default).
It holds no broker credentials: everything goes worker → risk gateway → IBKR. The gateway still refuses anything outside the limits.

Each tick: (1) refresh stored order states from the broker; (2) reconcile every `RECONCILE_EVERY_MS` (5 min); (3) if the NYSE entry
window is open, read account, positions and the gateway's quotes (`POST /quote`, allowlisted symbols only, fresh and with a
bid/ask), ask the strategy for ideas, size the first one, and submit a bracket. Client order id = `ogen-<NY date>-<SYMBOL>`: one
attempt per symbol per day, durable across restarts. A refusal is logged once and not retried that day. An uncertain submission is
resolved by lookup, never sent again.

## Sizing (`sizeIdea`)
Buy limit = ask. Stop = limit minus `stopPct` of it, rounded away from the limit; target = limit plus `targetPct`. Whole shares:
`min((perTradeRisk - 2 × feeReserve) / (limit - stop), perPosition / limit)`; none if less than one share, or if the stop would
sit at or above the bid.

## Strategy v1 = `probe-v1` — NO EDGE
It exists to exercise and measure the chain on paper (fills, slippage, fees, refusals, reconciliation). It proposes the first
allowlisted symbol (alphabetical) that is flat, untried today and quoted. Do not read profit or loss from it as evidence about any
real strategy. A real strategy implements `Strategy.propose(ctx)`; nothing else changes.

## Environment
`DATABASE_URL`, `GATEWAY_URL`, `GATEWAY_TOKEN` (worker token, ≥32), `IB_ACCOUNT` (must match `DU…`),
`BROKER_RISK_CONFIG` or `BROKER_RISK_CONFIG_JSON`, optional `TICK_MS` (≥5000), `RECONCILE_EVERY_MS` (≥60000).
The first start records the account's cash as the immutable baseline for reconciliation.

## Not done yet
- Needs a PostgreSQL: `infra/` has no database yet (add RDS, or run it beside the gateway on a managed Postgres).
- Not run against a real TWS. The worker is tested against the real gateway and a scripted fake broker.
- Close/exit management beyond the broker-held stop and target; no end-of-day flattening.
