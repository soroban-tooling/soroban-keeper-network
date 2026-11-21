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
