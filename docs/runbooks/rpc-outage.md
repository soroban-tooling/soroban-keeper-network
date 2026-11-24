# Runbook: Soroban RPC outage

Use this when `soroban_keeper_rpc_errors_total` rises, `/readyz` starts returning 503 with an RPC reason, or the RPC provider's status page reports an incident. Metric names and alert links are defined in `docs/OBSERVABILITY.md`.

## 1. Confirm the outage

1. Probe the configured endpoint: `curl -sS https://<rpc-host>/health`. A healthy node answers with `{"status":"healthy"}` and a ledger number.
2. Check whether the failure is provider-wide or local by querying a second public endpoint.
3. Record the current head ledger and the indexer's `soroban_indexer_ingestion_lag_ledgers` value. These are the baselines for recovery verification.

## 2. Behaviour during the outage

| Component | What happens | What does not happen |
|-----------|--------------|----------------------|
| Indexer | Ingestion stops advancing at the last stored ledger. `soroban_indexer_ingestion_lag_ledgers` grows. The API keeps serving already indexed data, so reads remain available but stale. | Events are not dropped. The cursor is only written after a range is fully ingested, so no gap is created. |
| Keeper bot v2 | Simulations and submissions fail and increment `soroban_keeper_rpc_errors_total`. Rounds continue and `soroban_keeper_round_duration_seconds` is still updated. `/readyz` returns 503 so orchestrators remove the pod from service. | The bot does not lose task state. With `DATABASE_URL` set, processed task IDs are reloaded on startup. Without it, in-memory state is lost on restart, so prefer a rolling restart. |
| Contract monitor | Polls fail, the last good samples stay on the `/metrics` endpoint and `onError` logs each failure. | Stale values remain visible. Check the scrape timestamp before trusting contract state. |
| Testnet canary | Registrations fail and increment `soroban_canary_missed_executions_total`. | Previously recorded execution times stay in the exposition output. They are historical, not current liveness. |
| `skn` CLI | Commands fail at simulation or submission with an RPC error. | Local keystore and configuration files are untouched. |

## 3. Switch RPC providers without losing state

All components take an explicit RPC URL. Changing it never changes the database or the ingest cursor.

| Component | Change | Restart needed | State risk |
|-----------|--------|----------------|------------|
| Indexer | Set `RPC_URL` in the indexer environment, or update `INDEXER_RPC_URL` if your deployment uses the prefixed name. | Yes | None. `ingest_cursor` stays in SQLite and ingestion resumes from the last fully stored ledger. |
| Keeper bot v2 | Set `RPC_URL` (see `examples/keeper-bot-v2/DEPLOYMENT.md`). When unset, the network preset is used. | Yes for a config change | None. Task state is in Postgres when `DATABASE_URL` is set. Use a rolling restart to avoid gaps if it is not. |
| Contract monitor | Set `RPC_URL` in the `ops/contract-monitor` environment. | Yes | None. It keeps no durable state. |
| Canary | Set `RPC_URL` in the `ops/canary` environment. Keep `CANARY_SECRET_KEY` unchanged. | Yes | None. Missed rounds are counters, not persisted tasks. |
| `skn` CLI | Pass `--rpc-url` if supported, or set `RPC_URL` for the invocation. | No | None. |

Before switching, confirm the new endpoint serves the same network by checking its passphrase or network field. Pointing a testnet deployment at mainnet would corrupt operational assumptions even though no data is written locally.

## 4. Verify after recovery

1. `/health` on the new endpoint returns healthy.
2. `soroban_indexer_ingestion_lag_ledgers` decreases toward 0 and `soroban_indexer_events_ingested_total` increases again.
3. `/readyz` on each keeper pod returns 200 with `{"status":"ready"}`.
4. `soroban_keeper_rpc_errors_total` stops increasing.
5. The contract monitor publishes fresh samples with a current scrape timestamp.
6. A new canary task is registered and executed within its target, and `soroban_canary_time_to_execution_seconds` is updated.

If lag keeps growing after RPC recovers, follow the `IndexerIngestFailures` section of `docs/runbooks/ops-alerts.md`. If balances stop growing while RPC is healthy, follow `KeeperBalanceNotGrowing` in the same runbook.
