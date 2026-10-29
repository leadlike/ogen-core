# Interactive Brokers paper trading — what exists, what is proven, how to prove the rest

## Pieces

| Piece | File | Role |
|---|---|---|
| Risk gateway | `src/gateway/risk.ts` | The only process that holds broker access. Every entry is checked here. |
| IB adapter | `src/broker/ibkr/broker.ts` | `Broker` interface over IB Gateway (TWS API). Lives inside the gateway process. |
| Quotes | `src/broker/ibkr/quotes.ts` | Real-time bid/ask for the allowlisted symbols. Delayed ticks are ignored. |
| Daemon | `src/gateway/daemon.ts`, `main.ts` | `npm run gateway`. Refuses non-paper accounts/ports and public bind addresses. |
| Verification | `scripts/verify-ibkr-paper.ts` | `npm run verify:ibkr` — the end-to-end check on YOUR paper account. |

## Conventions

- Our client order id travels in IB's `orderRef`: entry `<id>`, stop `<id>#STP`, target `<id>#TGT`, close `<id>`.
- A bracket is three orders sent as one unit (`transmit=false, false, true`). Stop and target are one OCA group named after the entry.
- A close is a market sell of the WHOLE position, placed inside the bracket's OCA group, so the old stop cannot also sell.
  Partial closes are refused (`PARTIAL_CLOSE_UNSUPPORTED`).
- Order ids come from IB's `nextValidId` on every connection; the adapter's counter only moves forward.
- After a timeout the outcome is UNCERTAIN: the caller looks the order up by `orderRef`; nothing is ever re-sent blindly.
  A lookup that gets no answer fails loudly; "no such order" (`null`) is returned only after IB answered completely.
- Executions are reported with their real commission. If the commission report has not arrived the call fails
  (`COMMISSION_PENDING`) rather than reporting a made-up zero fee.

## Environment of the daemon

`GATEWAY_TOKEN`, `GATEWAY_ADMIN_TOKEN` (>= 24 chars, different), `IB_ACCOUNT` (`DU...`), `IB_PORT` (4004 for the
gnzsnz container relay, 4002 for a bare IB Gateway, 7497 for TWS paper), `IB_HOST`, `IB_CLIENT_ID`,
`BROKER_RISK_CONFIG`, `GATEWAY_STATE_FILE`, `GATEWAY_HOST` (loopback/private), `GATEWAY_PORT`.
On AWS the two tokens and the IB credentials come from Secrets Manager, never from the task definition text.

## Proven by tests (fake TWS, real PostgreSQL)

The adapter's logic: bracket structure and flags, acknowledgement, definite vs uncertain rejects, silence,
socket failure mid-send, duplicate sends, id counter, lookup after restart, whole-position close in the OCA group,
cancel, positions/cash conversion (cents, whole shares, USD only), executions + commissions, reconciliation against
the books, quotes (bid floor / ask ceiling, delayed ticks ignored), daemon refusals, the full chain
worker -> HTTP gateway -> risk checks -> adapter -> TWS.

## NOT proven — assumptions about the real IB that only the paper run can confirm

1. The event sequence IB really sends for a bracket (acknowledgement statuses, `PreSubmitted` for children).
2. Partial fills of a bracket entry: that the children cover exactly the filled shares.
3. That a close order can join an existing OCA group and cancels the stop/target when it fills.
4. Which fees `commissionReport` itemises (regulatory fees on sells may differ) — the reconciliation step shows any gap.
5. Execution time zone (`execTimeZone`, default America/New_York) and that `reqExecutions` returns the whole day.
6. Completed-order records (`reqCompletedOrders`) for orders finished before a restart.
7. Real-time data: that your paper account has the market-data subscription (otherwise: no quote, no entry).
8. The daily forced logout / restart of IB Gateway and the 2FA behaviour with IBC. The adapter reconnects after a socket
   drop (`autoReconnectMs`), but whether IBC restores the session unattended is only learnt by running it.

## Run the check

```
IB_ACCOUNT=DU1234567 IB_PORT=4004 BROKER_RISK_CONFIG=config/broker-risk.json \
VERIFY_SYMBOL=<symbol from your allowlist, price below the per-position cap> \
VERIFY_CONFIRM=PLACE_PAPER_ORDERS \
VERIFY_DATABASE_URL=postgres://...scratch-db... npm run verify:ibkr
```

During US regular hours only. It places a real 1-share bracket in the paper account, closes it, and writes
`verify-ibkr-report-<time>.json` (account masked). Send that report back to decide what to fix.
