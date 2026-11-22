# Observability: metrics, logs and exposure

This document is the canonical scheme for metric names, label names and
structured log fields across the Soroban Keeper Network. It is the reference
used by the metric-name tests (see [Machine-readable contract](#machine-readable-contract)),
so renaming a metric or adding an undocumented one is a failing change.

Scope: the on-chain contracts, the indexer, the v2 keeper bot and the v1
example keeper bot. Design background lives in
[`docs/INDEXER_DESIGN.md`](INDEXER_DESIGN.md) and
[`docs/KEEPER_BOT_V2_DESIGN.md`](KEEPER_BOT_V2_DESIGN.md).

## Naming scheme

A metric name has the form:

```
<namespace>_<subject>_<measurement>[_<unit>]
```

- **Namespaces.** `soroban_indexer_` for the indexer, `soroban_keeper_` for
  both keeper bots. Using one namespace for the bots is deliberate: a metric
  with the same meaning in v1 and v2 must have the same name.
- **Subject** is a lowercase snake_case noun (`tasks`, `rpc_errors`,
  `ingestion`, `api_requests`, `balance`).
- **Measurement** describes what is counted (`total`, `duration`, `lag`,
  `connections`, `hits`).
- **Units** are explicit suffixes: `_seconds` for durations, `_stroops` for
  XLM amounts, `_ledgers` for ledger counts. A ratio uses `_ratio`. Counters
  end in `_total`, per Prometheus convention.

Prometheus HELP/TYPE lines must accompany every exported metric. A gauge and
a counter must not share a name with different semantics in another component.

### Label rules

- Label names are lowercase snake_case.
- Label values with bounded cardinality only. Never use a task id, a ledger
  hash, a full URL, a database URL, an account secret or a signing key as a
  label value.
- `task_type`, `reason`, `error_type`, `event_type` and `status` are the
  approved categorical labels. `address` is permitted only for a public
  Stellar account address in `soroban_keeper_balance_stroops` (see
  [Security review](#security-review-secrets-in-labels-and-logs)).
- Route labels must use a normalised route template such as `/v1/tasks/:id`,
  never the concrete path with an id interpolated.

## Metric catalogue

Status key: **shipped** means present on `main` today; **planned** means the
named issue is responsible for adding it. A planned metric is still part of
the documented scheme, but a scrape test must not require it to be present
until its issue has landed.

### Keeper bots (`soroban_keeper_`)

These names are defined by
[`examples/keeper-bot-v2/src/metrics.ts`](../examples/keeper-bot-v2/src/metrics.ts)
and are the reference for the v1 bot's optional endpoint.

| Name | Type | Labels | Meaning | Status |
| --- | --- | --- | --- | --- |
| `soroban_keeper_rounds_total` | counter | none | Polling rounds started | planned (v1 #717) |
| `soroban_keeper_tasks_evaluated_total` | counter | none | Candidate tasks evaluated | shipped |
| `soroban_keeper_tasks_claimed_total` | counter | none | Tasks claimed by the keeper | shipped |
| `soroban_keeper_tasks_claimed_by_type` | counter | `task_type` | Claims broken down by executor type | shipped |
| `soroban_keeper_tasks_executed_total` | counter | none | Tasks successfully executed | shipped |
| `soroban_keeper_tasks_executed_by_type` | counter | `task_type` | Executions broken down by executor type | shipped |
| `soroban_keeper_tasks_skipped_total` | counter | `reason` | Tasks skipped, with the structured reason | shipped |
| `soroban_keeper_tasks_skipped_by_type` | counter | `task_type`, `reason` | Skips broken down by type and reason | shipped |
| `soroban_keeper_net_profit_stroops_total` | counter | none | Net profit in stroops | shipped |
| `soroban_keeper_net_profit_stroops_by_type` | counter | `task_type` | Net profit by executor type | shipped |
| `soroban_keeper_round_duration_seconds` | gauge | none | Duration of the last polling round | shipped |
| `soroban_keeper_balance_stroops` | gauge | `address` | Current on-chain keeper balance | shipped |
| `soroban_keeper_rpc_errors_total` | counter | `error_type` | RPC errors by classified type | shipped |

The v1 bot exposes a subset: rounds, claims, executions, skips by reason and
RPC errors. Where a name exists here, v1 uses the exact same spelling.

### Indexer (`soroban_indexer_`)

The endpoint is added by #714. `INDEXER_METRICS_BIND` may place it on a
separate listener; otherwise `/metrics` is served on the API listener.

| Name | Type | Labels | Meaning | Status |
| --- | --- | --- | --- | --- |
| `soroban_indexer_ingestion_lag_ledgers` | gauge | none | Head ledger minus last ingested ledger | planned (#714) |
| `soroban_indexer_events_ingested_total` | counter | `event_type` | Events ingested, by event type | planned (#714) |
| `soroban_indexer_api_requests_total` | counter | `route`, `status` | API requests by normalised route and status class | planned (#714) |
| `soroban_indexer_api_request_duration_seconds` | histogram | `route` | API request latency by normalised route | planned (#714) |
| `soroban_indexer_cache_hit_ratio` | gauge | none | Ratio of cache hits to lookups | planned (#714) |
| `soroban_indexer_rate_limit_rejections_total` | counter | none | Requests rejected by the rate limiter | planned (#714) |
| `soroban_indexer_websocket_connections` | gauge | none | Currently open WebSocket connections | planned (#714) |

## Structured log fields

Every structured log line carries these fields when the value is known.
Human-readable default output renders them as key/value pairs;
`INDEXER_LOG_FORMAT=json` emits them as JSON keys.

| Field | Type | Meaning |
| --- | --- | --- |
| `timestamp` | RFC 3339 | Time of the event |
| `level` | string | `trace`, `debug`, `info`, `warn` or `error` |
| `message` | string | Static human-readable message, never interpolated secrets |
| `request_id` | string | Correlation id, generated per API request and returned as `X-Request-Id` |
| `component` | string | `indexer`, `keeper-bot`, `keeper-bot-v2` or `cli` |
| `error` | string | Error display text. Must be scrubbed before logging |
| `ledger_range` | string | Inclusive `start..=end` for an ingest pass |
| `event_count` | integer | Events handled in an ingest pass |
| `duration_seconds` | number | Duration of the pass or request |
| `route` | string | Normalised route template, as in the metric label |
| `status` | integer or string | HTTP status or class |

Trace spans wrap each ingest pass and each API request and carry the same
`ledger_range`, `event_count`, `route`, `status` and `duration_seconds`
fields, so a slow pass can be followed from a span to its log lines.

## Security review: secrets in labels and logs

This section is the review required by #731. It covers every exported label
and every log field listed above.

| Surface | Risk | Finding | Mitigation |
| --- | --- | --- | --- |
| `rpc_url` in the indexer startup log | An RPC provider URL can embed an API key in its path or query string | The value was previously logged verbatim | Redacted at the log call: only scheme and host are emitted; user info and query are dropped |
| `database_url` in config | Contains host, credentials and database name | Never used as a label and never logged | Config errors must name the variable, not its value |
| Keeper signing keys | Can sign transactions and drain accounts | Never a metric label or log field | Loaded from a key source that does not echo it; error paths report only the source name |
| `soroban_keeper_balance_stroops{address}` | Looks sensitive | A Stellar public address is deliberately public and has bounded cardinality per pool | Allowed. Never add a secret key or seed as a label |
| `error` log field | Driver errors can contain a full connection string | Possible leak when an error is formatted verbatim | Scrub credentials and URLs before recording the field |
| Task ids, ledger hashes, concrete paths | High cardinality and information disclosure | Not used as labels | Use `task_type`, normalised `route` and status classes instead |

The standing rule: **no label or log field may contain a secret, a full
database URL, or a signing key.** Adding a new label or field requires
checking it against this table.

## Exposure recommendation

`/metrics` is not authenticated in the examples. It exposes operational
counts and public account addresses, not secrets, but it still reveals
traffic patterns and internal topology.

- Bind the indexer metrics endpoint to a private network interface, or a
  separate bind address via `INDEXER_METRICS_BIND`, and restrict it at the
  firewall or service mesh. Do not publish it through the public API
  gateway.
- Bind the keeper bot metrics server to `127.0.0.1` by default. If a scraper
  runs on another host, put an authenticating reverse proxy in front of it
  or tunnel the scrape over SSH. A bot's endpoint must never be bound to
  `0.0.0.0` without authentication.
- Scrape over TLS or within the cluster network. Keep metrics retention
  aligned with the observability stack's access controls.

These recommendations apply to #714, #715, #717 and the existing v2 metrics
server equally.

## Machine-readable contract

The metric-name tests read this file as the source of truth:

- `examples/keeper-bot-v2/test/metricsNames.test.ts` starts the v2 collector,
  scrapes `/metrics` and asserts that (a) every emitted name appears in the
  **Keeper bots** table above and (b) the always-present core names are
  emitted. A renamed or undocumented metric fails both checks.
- `indexer/tests/metrics_names.rs` reads the **Indexer** table and asserts
  that a scrape of the endpoint (when `INDEXER_METRICS_URL` points at a
  running indexer) matches it exactly. When no URL is configured it validates
  this document's structure so a broken or incomplete catalogue still fails
  the test.

When adding a metric, add its row here in the same change. When removing or
renaming one, remove the row in the same change. Both directions are enforced
by the tests above.
# Observability

This page is the canonical list of metric and alert names used by `docs/SLO.md`, `docs/runbooks/indexer-lag.md` and the provisioned Grafana dashboards. Other documents link here instead of restating the names.

## Local stack

From the repository root, check the prerequisites and start the stack:

```sh
node ops/scripts/check-stack.mjs
docker compose -f ops/docker-compose.yml up
```

Prometheus listens on `localhost:9090` and Grafana on `localhost:3001` by default. Grafana is provisioned with the Prometheus datasource and the two dashboards under `ops/grafana/`.

The stack expects these files from the monitoring and alerting work to be present:

- `ops/prometheus/alerts.yml`
- `ops/grafana/indexer.json`
- `ops/grafana/keeper-bot-v2.json`

The preflight script names any missing file and exits non zero, so a partially provisioned stack fails with a clear message rather than a container error. The rule file is mounted read only at `/etc/prometheus/alerts.yml` and referenced from `prometheus.yml`.

### Pointing the stack at real targets

The defaults assume services running on the Docker host:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PROM_INDEXER_TARGET` | `host.docker.internal:8080` | Indexer `/metrics` endpoint |
| `PROM_KEEPER_TARGET` | `host.docker.internal:9102` | Keeper bot metrics endpoint |
| `PROM_CANARY_TARGET` | `host.docker.internal:9103` | Canary metrics endpoint |
| `PROM_RETENTION` | `30d` | Prometheus time series retention |
| `PROMETHEUS_PORT` | `9090` | Host port for Prometheus |
| `GRAFANA_PORT` | `3001` | Host port for Grafana |
| `GRAFANA_ADMIN_PASSWORD` | `admin` | Initial Grafana admin password |

Set them in the environment or in a `.env` file next to `ops/docker-compose.yml`, then start the stack as before. Compose substitutes them into the container, and the Prometheus entrypoint renders `prometheus.yml` from the template placeholders. For example:

```sh
PROM_INDEXER_TARGET=indexer.internal:8080 \
PROM_KEEPER_TARGET=keeper.internal:9102 \
docker compose -f ops/docker-compose.yml up
```

On Linux, `host.docker.internal` is mapped to the host gateway by `extra_hosts`. Targets must be reachable from inside the Prometheus container, so use a container name on the Compose network or a routable host address.

## Metric names

Indexer metrics are exported by `/metrics` and are named by the indexer itself. Keeper and canary metrics are exposed by those services.

| Metric | Type | Labels | Meaning |
| --- | --- | --- | --- |
| `soroban_indexer_ingestion_lag_ledgers` | gauge | none | Head ledger minus last ingested ledger |
| `soroban_indexer_events_ingested_total` | counter | `event_type` | Events stored, by wire event type |
| `soroban_indexer_api_requests_total` | counter | `route`, `status` | API responses by normalised route and status class |
| `soroban_indexer_api_request_duration_seconds` | histogram | `route` | API latency, plus the `_bucket`, `_sum` and `_count` series |
| `soroban_indexer_cache_hit_ratio` | gauge | none | Ratio of aggregate cache hits to lookups |
| `soroban_indexer_rate_limit_rejections_total` | counter | none | Requests rejected by the API limiter |
| `soroban_indexer_websocket_connections` | gauge | none | Open WebSocket connections |
| `soroban_keeper_rpc_errors_total` | counter | service supplied | Keeper RPC failures |
| `soroban_keeper_balance_stroops` | gauge | service supplied | Withdrawable keeper balance |
| `soroban_keeper_round_duration_seconds` | gauge | service supplied | Duration of the last keeper round |
| `soroban_canary_time_to_execution_seconds` | gauge | service supplied | End to end canary execution time |
| `soroban_canary_missed_executions_total` | counter | service supplied | Canary tasks missed by keepers |

The histogram exports three companion series: `soroban_indexer_api_request_duration_seconds_bucket`, `soroban_indexer_api_request_duration_seconds_sum` and `soroban_indexer_api_request_duration_seconds_count`.

Label values are bounded. Routes are normalised templates such as `/v1/tasks/{task_id}`, status is a class such as `2xx` or `5xx`, and event types come from the fixed event vocabulary.

## Alert names

The alert rules live in `ops/prometheus/alerts.yml`.

| Alert | Component | Fires when |
| --- | --- | --- |
| `IndexerIngestionLag` | indexer | Lag above 10 ledgers for five minutes |
| `IndexerIngestFailures` | indexer | No events stored while lagging for ten minutes |
| `IndexerApiErrorRate` | indexer | 5xx share above 5 percent for five minutes |
| `KeeperRpcErrors` | keeper-bot-v2 | More than ten RPC errors in five minutes |
| `KeeperBalanceNotGrowing` | keeper-bot-v2 | Balance flat over 24 hours |
| `KeeperRoundsStalled` | keeper-bot-v2 | Round metric stale for five minutes |
| `CanaryExecutionLate` | canary | Execution over 60 seconds or a missed execution |

`IndexerIngestionLag` and `IndexerIngestFailures` are handled in `docs/runbooks/indexer-lag.md`. The full alert runbook is `docs/runbooks/ops-alerts.md`.
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
