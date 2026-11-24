# Operational alert runbook

This runbook covers the alerts shipped in `ops/prometheus/alerts.yml` (issue #719). Each section is linked from the matching alert's `runbook_url` annotation. For a wider RPC incident, follow `docs/runbooks/rpc-outage.md` as well.

## IndexerIngestionLag

**Signal.** `soroban_indexer_ingestion_lag_ledgers > 10` for five minutes.

**Impact.** API results and websocket events trail the network. Keepers may act on stale task state.

**Recovery.**

1. Check the indexer process and its RPC endpoint: `curl -s <RPC_URL>/health`.
2. Confirm the ingested cursor is advancing in the `ingest_cursor` table.
3. If RPC is healthy but the cursor is stuck, restart the indexer. Ingestion is keyed and replayable, so a restart resumes from the last stored ledger.
4. If RPC is unhealthy, switch providers using the procedure in `docs/runbooks/rpc-outage.md`.

**Verify.** Lag returns to 0 and new events appear in `/v1/tasks`.

## IndexerIngestFailures

**Signal.** No increase in `soroban_indexer_events_ingested_total` for ten minutes while `soroban_indexer_ingestion_lag_ledgers` is positive.

**Impact.** Events are being skipped or rejected by the parser, not merely delayed.

**Recovery.**

1. Inspect indexer logs for `unrecognised` event shapes and note the contract event name.
2. Compare the deployed contract `VERSION` against the SDK range in `SUPPORTED_CONTRACT_VERSIONS`.
3. If the event shape is new, pin the affected ledger range and upgrade the indexer parser before backfilling.
4. Restart the indexer and watch the unrecognised counter.

**Verify.** `soroban_indexer_events_ingested_total` increases again and the lag alert clears.

## IndexerApiErrorRate

**Signal.** More than 5 percent of indexer API responses are 5xx for five minutes.

**Impact.** Clients, dashboards and the indexer TypeScript client see failed reads.

**Recovery.**

1. Identify the failing route from `soroban_indexer_api_requests_total{status=~"5.."}`.
2. Check SQLite disk space and lock contention. The indexer stores state in SQLite, so a full disk or a long write transaction shows up as API errors.
3. Restart the indexer process if the database is healthy but errors persist.
4. Roll back a recent API change if the errors started with a deployment.

**Verify.** The 5xx ratio drops below 5 percent and the affected route returns 200.

## KeeperRpcErrors

**Signal.** More than ten `soroban_keeper_rpc_errors_total` events in five minutes.

**Impact.** Simulations and submissions fail, so tasks may be missed and rewards lost.

**Recovery.**

1. Check the RPC endpoint used by the bot directly with `curl -s <RPC_URL>/health`.
2. Group errors by `error_type` in the dashboard to distinguish timeouts from rejected transactions.
3. Switch to a healthy RPC provider by updating `RPC_URL` (or the network preset) and restarting the bot. Task state lives in Postgres when `DATABASE_URL` is set, so a restart does not lose processed task IDs.
4. If errors are transaction rejections rather than transport failures, inspect contract pause state using the contract monitor metrics.

**Verify.** The RPC error rate returns to zero and the bot logs successful rounds.

## KeeperBalanceNotGrowing

**Signal.** `soroban_keeper_balance_stroops` has not increased over 24 hours.

**Impact.** The keeper is not earning rewards. It may be unfunded, outbid, or unable to claim.

**Recovery.**

1. Check `soroban_keeper_tasks_executed_total` over the same window. If it is flat, the keeper is not executing tasks.
2. Check the keeper's stake and whether `min_stake` rose above it.
3. Fund the keeper account if its XLM balance is near zero, using the steps in `docs/runbooks/keeper-unfunded.md` if that runbook is present on the deployed branch.
4. Review fee settings: a fee ceiling below the network percentile can make every candidate unprofitable.

**Verify.** Executions resume and the on-chain balance increases after the next sweep.

## KeeperRoundsStalled

**Signal.** `soroban_keeper_round_duration_seconds` has not been refreshed for five minutes.

**Impact.** The process may still be alive but no polling is happening.

**Recovery.**

1. Check the container restart count and application logs for a fatal error.
2. Confirm the process is not blocked on a database connection by checking `DATABASE_URL` reachability.
3. Restart the bot. With persistent storage enabled, previously processed task IDs are reloaded on startup.
4. If restarts repeat, capture the startup configuration error and fix the invalid environment variable.

**Verify.** Round duration is written again and task counters move.

## CanaryExecutionLate

**Signal.** `soroban_canary_time_to_execution_seconds > 60` or a missed execution in the last ten minutes.

**Impact.** End-to-end liveness is broken: metrics alone no longer prove a task can be executed.

**Recovery.**

1. Check `soroban_canary_missed_executions_total` and the last execution timestamp to determine how many rounds were missed.
2. Confirm the canary registration transaction succeeded and its deadline has not passed.
3. Check keeper RPC health and the registry pause state using the contract monitor metrics.
4. If keepers are healthy but the canary is not claimed, raise the canary reward above the contract's `min_reward` floor and restart the canary.
5. Escalate to the on-call operator if two consecutive rounds are missed on testnet.

**Verify.** A new canary task is registered and executed within the target, and the time-to-execution gauge is updated.
