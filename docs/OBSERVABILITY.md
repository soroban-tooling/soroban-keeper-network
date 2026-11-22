# Observability plan (E16 follow-up, issue #713)

This document is the single naming contract for the keeper-registry contract, the indexer, the keeper bots and the testnet canary. Dashboards in `ops/grafana/` and alert rules in `ops/prometheus/alerts.yml` are checked against the metric families below by CI.

## 1. Naming scheme

Every metric starts with `soroban_<component>_`. Counters that count events end in `_total`. Durations are seconds, balances and rewards are stroops, ledgers are whole ledger numbers. Label values are bounded: route labels use normalised templates such as `/v1/tasks/{task_id}`, never raw IDs; status labels are classes such as `2xx` and `5xx`; error types use the SDK's stable error names.

The prefix split is:

| Component | Prefix | Exporter |
|-----------|--------|----------|
| Keeper-registry contract | `soroban_contract_` | `ops/contract-monitor/`, views and ledger TTL only |
| Indexer | `soroban_indexer_` | `GET /metrics` on the indexer API listener |
| Keeper bots | `soroban_keeper_` | `startMetricsServer` on `METRICS_PORT` |
| Testnet canary | `soroban_canary_` | `ops/canary/` |

## 2. Required metrics and labels

### 2.1 Keeper-registry contract

Read-only poller. It needs no signing key and never submits a transaction.

| Metric | Type | Labels | Meaning |
|--------|------|--------|---------|
| `soroban_contract_paused` | gauge | `contract_id` | 1 when `is_paused()` is true, otherwise 0 |
| `soroban_contract_fees_accrued_stroops` | gauge | `contract_id` | Fees awaiting `sweep_fees`, raw stroops |
| `soroban_contract_task_count` | gauge | `contract_id` | `task_count()` from the registry |
| `soroban_contract_version` | gauge | `contract_id` | Deployed contract `VERSION` |
| `soroban_contract_instance_ttl_remaining_seconds` | gauge | `contract_id` | Estimate from the instance ledger entry expiry, using the five-second ledger target |

### 2.2 Indexer

Served as Prometheus text on the API listener. Metrics are kept in one registry so ingestion, API requests, rate limiting and WebSocket connections cannot drift apart.

| Metric | Type | Labels | Meaning |
|--------|------|--------|---------|
| `soroban_indexer_ingestion_lag_ledgers` | gauge | none | Head ledger minus last ingested ledger, 0 before the first observation |
| `soroban_indexer_events_ingested_total` | counter | `event_type` | Stored events by contract event name |
| `soroban_indexer_api_requests_total` | counter | `route`, `status` | Responses by normalised route template and status class |
| `soroban_indexer_api_request_duration_seconds` | histogram | `route` | Response latency buckets, sum and count |
| `soroban_indexer_cache_hit_ratio` | gauge | none | Leaderboard cache hits divided by lookups, 0 before any lookup |
| `soroban_indexer_rate_limit_rejections_total` | counter | none | Responses rejected with 429 |
| `soroban_indexer_websocket_connections` | gauge | none | Open WebSocket subscriptions |

The indexer `/metrics` endpoint is tracked separately in issue #714. This document fixes the names it must export so dashboards and alerts do not need to change when that endpoint lands.

### 2.3 Keeper bots

`keeper-bot-v2` exports the following from `startMetricsServer`. Optional families are only present once the relevant data exists, so dashboards must tolerate an absent series.

| Metric | Type | Labels | Meaning |
|--------|------|--------|---------|
| `soroban_keeper_tasks_evaluated_total` | counter | none | Candidate tasks evaluated |
| `soroban_keeper_tasks_claimed_total` | counter | none | Tasks claimed |
| `soroban_keeper_tasks_claimed_by_type` | counter | `task_type` | Claims split by task type |
| `soroban_keeper_tasks_executed_total` | counter | none | Successful executions |
| `soroban_keeper_tasks_executed_by_type` | counter | `task_type` | Executions split by task type |
| `soroban_keeper_tasks_skipped_total` | counter | `reason` | Skips split by reason |
| `soroban_keeper_tasks_skipped_by_type` | counter | `task_type`, `reason` | Skips split by type and reason |
| `soroban_keeper_net_profit_stroops_total` | counter | none | Net profit in stroops |
| `soroban_keeper_net_profit_stroops_by_type` | counter | `task_type` | Net profit split by task type |
| `soroban_keeper_round_duration_seconds` | gauge | none | Duration of the last polling round |
| `soroban_keeper_balance_stroops` | gauge | `address` | On-chain withdrawable balance, optional |
| `soroban_keeper_rpc_errors_total` | counter | `error_type` | RPC failures, optional |

`keeper-bot` v1 has no exporter. Its signals are covered indirectly by the canary, which fails when no bot executes the probe task. Adding v1 metrics is deferred to the maintenance backlog because it would require changing a deliberately single-file reference implementation.

### 2.4 Testnet canary

| Metric | Type | Labels | Meaning |
|--------|------|--------|---------|
| `soroban_canary_last_execution_timestamp_seconds` | gauge | `task_id` | Unix timestamp of the last observed execution |
| `soroban_canary_time_to_execution_seconds` | gauge | `task_id` | Registration to execution, in seconds |
| `soroban_canary_executions_total` | counter | `task_id` | Executions observed within the target |
| `soroban_canary_missed_executions_total` | counter | `task_id` | Rounds with no execution inside the target |

## 3. Structured logging format

All components use one flat JSON object per line on stdout. There is no nested `fields` object and no free-form message prefix. The indexer selects this format with `INDEXER_LOG_FORMAT=json`; other components use it unconditionally in container deployments.

Every line carries these fields:

| Field | Type | Meaning |
|-------|------|---------|
| `timestamp` | string | RFC 3339 with an explicit offset |
| `level` | string | `debug`, `info`, `warn` or `error` |
| `component` | string | `indexer`, `keeper-bot-v2`, `contract-monitor`, `canary` or `cli` |
| `event` | string | Stable machine-readable event name, for example `round_completed` |
| `message` | string | Human-readable sentence, never the only source of a fact |

Conditional fields:

| Field | When |
|-------|------|
| `task_id` | The line concerns a specific task |
| `ledger` | The line concerns an ingest position |
| `error_type` | The line reports a classified failure |
| `duration_ms` | The line measures an operation |
| `contract_id` | The line concerns a registry deployment |

Secrets are never logged. Secret keys, API keys and full connection strings are replaced with `[REDACTED]`. Log aggregation must treat `message` as display text and alert on `event` and `error_type` instead.

## 4. Alerts and runbooks

Alert rules live in `ops/prometheus/alerts.yml` and are validated with `promtool check rules` in CI. Each rule carries a `runbook_url` annotation.

| Alert | Primary signal | Runbook |
|-------|----------------|---------|
| `IndexerIngestionLag` | `soroban_indexer_ingestion_lag_ledgers > 10` for 5m | `docs/runbooks/ops-alerts.md#indexeringestionlag` |
| `IndexerIngestFailures` | No ingested events for 10m while lagging | `docs/runbooks/ops-alerts.md#indexeringestfailures` |
| `IndexerApiErrorRate` | 5xx ratio above 5 percent for 5m | `docs/runbooks/ops-alerts.md#indexerapierrorrate` |
| `KeeperRpcErrors` | More than 10 RPC errors in 5m | `docs/runbooks/ops-alerts.md#keeperrpcerrors` |
| `KeeperBalanceNotGrowing` | No balance increase over 24h | `docs/runbooks/ops-alerts.md#keeperbalancenotgrowing` |
| `KeeperRoundsStalled` | Round metric older than 5m | `docs/runbooks/ops-alerts.md#keeperroundsstalled` |
| `CanaryExecutionLate` | Execution over target or a missed round | `docs/runbooks/ops-alerts.md#canaryexecutionlate` |

For a provider-wide outage, operators also follow `docs/runbooks/rpc-outage.md`. That runbook describes the per-component behaviour during an outage and the exact variable to change for each component without losing state.

## 5. Ownership

| Concern | Owner |
|---------|-------|
| Contract monitor, canary, dashboards, alert rules | Ops tooling in `ops/` |
| Indexer `/metrics` endpoint | Indexer maintainers, issue #714 |
| Bot metrics and probes | Keeper bot maintainers, issue #718 |
| Name changes to this document | Must update the catalog, dashboards, alerts and CI check in the same change |
