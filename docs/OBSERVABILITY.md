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
