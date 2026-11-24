# Service level objectives

These SLOs cover the indexer API, ingestion freshness and the testnet canary. Metric and alert names are defined in `docs/OBSERVABILITY.md`. Each expression uses a five minute rate or subquery step, and the thirty day window is applied as a reporting period rather than inside `rate`, which would be expensive and would hide short outages.

Prometheus in the local stack retains thirty days by default, matching these windows. A production backend should retain at least the same period.

## API availability

Target: 99.9 percent of requests are not 5xx over a rolling thirty day window.

```promql
avg_over_time(
  (
    sum(rate(soroban_indexer_api_requests_total{status!~"5.."}[5m]))
    /
    sum(rate(soroban_indexer_api_requests_total[5m]))
  )[30d:5m]
) >= 0.999
```

The numerator and denominator use the same metric, so a route with no traffic cancels out. The `status` label is a class such as `5xx`, not an individual code.

## API latency

Target: the worst five minute 95th percentile stays at or below 0.5 seconds over a rolling thirty day window.

```promql
max_over_time(
  (
    histogram_quantile(
      0.95,
      sum by (le) (rate(soroban_indexer_api_request_duration_seconds_bucket[5m]))
    )
  )[30d:5m]
) <= 0.5
```

The bucket boundaries are defined by the indexer. Aggregating by `le` before applying `histogram_quantile` is required when more than one route is present.

## Ingestion freshness

Target: lag stays at or below 10 ledgers for at least 99 percent of the thirty day window.

```promql
avg_over_time(
  (soroban_indexer_ingestion_lag_ledgers <= bool 10)[30d:5m]
) >= 0.99
```

`IndexerIngestionLag` alerts on the same threshold over five minutes. Sustained breaches are handled with `docs/runbooks/indexer-lag.md`.

## Canary time to execution

Target: the canary executes within 60 seconds for at least 99 percent of the thirty day window.

```promql
avg_over_time(
  (soroban_canary_time_to_execution_seconds <= bool 60)[30d:5m]
) >= 0.99
```

Absence of the canary series is not a pass. Alert on `CanaryExecutionLate`, which also covers missed executions.

## Error budget policy

Each target has a 0.1 percent or 1 percent budget depending on the SLO above. The budget is exhausted when the rolling thirty day expression has been out of target long enough that the window cannot recover without sustained good behavior.

When a budget is exhausted:

1. Pause risky deploys and configuration changes for the affected component.
2. Work the matching runbook, starting with `docs/runbooks/indexer-lag.md` for ingestion and `docs/runbooks/ops-alerts.md` for alerts.
3. Record the incident, its cause and the remediation in the repository tracker.
4. Resume normal deploys only after the rolling expression is back inside target for the full window.

Error budget burn is tracked from the same expressions, so there is no second set of metrics to keep in sync.
