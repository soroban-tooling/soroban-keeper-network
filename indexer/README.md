# Keeper Registry Indexer

Indexes the keeper registry's on-chain events into a queryable store, and
serves them over a REST API and a live WebSocket feed.

## Design

The `events` table is append-only and authoritative. Every current-state
answer — a task's status, a keeper's balance, the live fee — is folded from
that event history on read, never kept as separate mutable rows. A derived
view therefore cannot drift from the events that produced it, and replaying
the same events always yields the same state.

One process tracks one registry contract id on one network; a future
contract `VERSION` that changes event shapes is a coordinated indexer
release, not a live `version()` dispatch. Both decisions, and what happens
to already-ingested rows, are in [`docs/INDEXER_DESIGN.md`](../docs/INDEXER_DESIGN.md).

For the database itself — every table, its columns, and how the API's
derived views (a task's status, a keeper's balance, ...) are folded from
the raw `events` table — see [`docs/INDEXER_SCHEMA.md`](../docs/INDEXER_SCHEMA.md).

Ingestion polls the RPC's `getEvents`, the mechanism the keeper-bot already
uses. Backfill and steady-state polling share one parsing path
(`ingest::Ingestor::ingest_batch`); the only difference between them is the
ledger range being walked.

Ingestion is idempotent. A `(tx_hash, event_index)` pair identifies an
emission uniquely, so re-reading a ledger — an overlapping backfill page, a
retried poll, a restart mid-page — stores nothing twice.

## Configuration

Every variable is validated at startup. A misconfigured service reports all
problems at once and exits, rather than failing later inside the ingest loop.

| Variable | Required | Default | Meaning |
| --- | --- | --- | --- |
| `INDEXER_RPC_URL` | yes | — | Soroban RPC endpoint to poll |
| `INDEXER_CONTRACT_ID` | yes | — | Single registry contract id to filter on (one instance per deployment) |
| `INDEXER_DATABASE_URL` | yes | — | sqlx connection string, e.g. `sqlite://indexer.db` |
| `INDEXER_START_LEDGER` | yes | — | Ledger to backfill from on a fresh database |
| `INDEXER_BIND_ADDRESS` | no | `127.0.0.1:8080` | API bind address |
| `INDEXER_POLL_INTERVAL_SECS` | no | `5` | Seconds between polls once caught up |
| `INDEXER_BACKFILL_PAGE_SIZE` | no | `200` | Ledgers per page during backfill |
| `INDEXER_RATE_LIMIT_PER_SECOND` | no | `20` | Sustained API requests per second allowed per client |
| `INDEXER_RATE_LIMIT_BURST` | no | `40` | API request burst allowed per client |
| `INDEXER_MAX_HEALTHY_LAG_LEDGERS` | no | `60` | Ingestion lag, in ledgers, beyond which the health check reports unhealthy |
| `INDEXER_SHUTDOWN_DRAIN_SECS` | no | `30` | Max seconds a SIGINT/SIGTERM shutdown waits for an in-flight ingestion pass to finish and checkpoint before exiting anyway |
| `INDEXER_LOG` | no | `info` | `tracing` filter directive |
| `INDEXER_LOG_FORMAT` | no | `human` | `human` (default, readable) or `json` (one flat JSON object per line) |
| `INDEXER_OTLP_ENDPOINT` | no | unset | OTLP/HTTP collector URL for span export, for example `http://collector:4318` |

`INDEXER_START_LEDGER` should be the contract's deployment ledger. On a
network where that is not known exactly, any ledger at or before the
`initialize` call works: ingestion is idempotent, so starting early costs
extra scanning rather than correctness.

### Trace export

Set `INDEXER_OTLP_ENDPOINT` to an OTLP over HTTP collector URL to export spans:

```bash
export INDEXER_OTLP_ENDPOINT=http://collector.example.org:4318
```

Export is off by default. When the variable is unset, no exporter, tracer
provider or batch worker is constructed, and the subscriber installs only the
formatting layer. A set but blank value is reported as a configuration error at
startup. The endpoint must use `http://` or `https://`.

`INDEXER_LOG` filters both the formatting layer and the export layer, so a
narrow directive such as `keeper_indexer=info` bounds span volume on a busy
deployment. Spans are batched and the provider is shut down after the service
stops, so pending spans are flushed before exit.

## Running

```bash
export INDEXER_RPC_URL=https://soroban-testnet.stellar.org
export INDEXER_CONTRACT_ID=C...
export INDEXER_DATABASE_URL=sqlite://indexer.db
export INDEXER_START_LEDGER=1000

cargo run -p keeper-indexer
```

That one process does everything: it backfills from the checkpoint (or
`INDEXER_START_LEDGER` on a fresh database), keeps polling once caught up, and
serves the API on `INDEXER_BIND_ADDRESS`:

- REST under `/v1` (`/v1/health`, `/v1/tasks/{id}`, `/v1/events`, ...), described
  by `openapi.yaml`.
- A live WebSocket feed at `/v1/stream`.
- Prometheus metrics at `/metrics`, served on the same listener.

### Logging

`INDEXER_LOG_FORMAT=human` is the default and keeps the readable output the
indexer has always produced. Set `INDEXER_LOG_FORMAT=json` for log pipelines:
each line is one JSON object with root-level `timestamp` (RFC 3339), `level`,
`message` and any structured fields known at that point (`component`,
`request_id`, `route`, `status`, `ledger_range`, `event_count`,
`duration_seconds`, `error`). `INDEXER_LOG` still selects what is logged; the
format only changes how it is rendered. An unknown value is reported with the
other configuration problems at startup instead of silently falling back.

### Metrics

`GET /metrics` returns Prometheus text format on the API listener, so only one
port needs to be exposed. It is subject to the same per-client rate limit as
the REST API. Keep `INDEXER_BIND_ADDRESS` private or put the endpoint behind an
authenticated proxy: the values are operational counts and bounded labels, not
secrets, but they still describe your deployment.

| Metric | Type | Labels | Meaning |
| --- | --- | --- | --- |
| `soroban_indexer_ingestion_lag_ledgers` | gauge | none | Head ledger minus last ingested ledger; `0` before the first observation |
| `soroban_indexer_events_ingested_total` | counter | `event_type` | Newly stored events by contract event name |
| `soroban_indexer_api_requests_total` | counter | `route`, `status` | Responses by normalised route template and status class (`2xx`, `4xx`, ...) |
| `soroban_indexer_api_request_duration_seconds` | histogram | `route` | Response latency buckets, sum and count |
| `soroban_indexer_cache_hit_ratio` | gauge | none | Leaderboard cache hits divided by lookups; `0` before any lookup |
| `soroban_indexer_rate_limit_rejections_total` | counter | none | Responses rejected with 429 |
| `soroban_indexer_websocket_connections` | gauge | none | Open WebSocket subscriptions |

Route labels come from the router's matched template. Unmatched paths are
collapsed by replacing long identifier-like segments, so a caller cannot create
a new time series with an arbitrary URL. No metric label contains a raw path,
secret, full URL or signing key.

### Startup, in order

1. Configuration is validated. Every problem is reported at once, and the
   process exits with status `2`.
2. The RPC endpoint is health-checked, so a wrong `INDEXER_RPC_URL` stops the
   boot instead of failing the first poll.
3. The SQLite database is opened and migrations are applied.
4. The API address is bound. A port that is already taken fails here, before
   anything is ingested.
5. Ingestion and the HTTP server start together.

### Shutdown and failures

Ingestion and the HTTP server are supervised as one unit (`src/service.rs`).

- **SIGINT (ctrl-c) or SIGTERM** (what a container orchestrator sends on a
  normal stop or restart) starts a graceful shutdown. Ingestion stops starting
  new passes and lets the one in flight finish and checkpoint. The HTTP server
  stops accepting connections and lets in-flight requests finish. The process
  exits `0`. Both are bounded by `INDEXER_SHUTDOWN_DRAIN_SECS` (default 30), so
  a stuck pass or an open WebSocket subscription cannot block shutdown
  indefinitely. If the bound is hit, the process exits anyway and the next
  start resumes from the last checkpoint, since ingestion is idempotent.
- **If either half fails**, the other is stopped and the process exits
  non-zero with the error in the log. That covers an RPC error, a ledger the
  source later reports differently (see `src/reorg.rs`), and the HTTP server
  dying. A process manager (systemd, Kubernetes) should restart it, and it
  resumes from the checkpoint. It never keeps serving a database that nothing is
  feeding.

## Storage

SQLite, through `sqlx`, is the only storage path. The schema is the
migrations in `indexer/migrations/`, applied automatically on start. There is no
PostgreSQL support; an earlier `tokio-postgres` schema and ingest path was
removed so there is only one schema to build against.

## Tests

```bash
cargo test -p keeper-indexer
```

Tests run against in-memory SQLite and a fixture event source, so no RPC
endpoint or external database is needed. `tests/service_process.rs` goes
further: it starts the real `keeper-indexer` binary against a mock Soroban RPC,
checks ingested events through the REST and WebSocket routes, checks that
SIGTERM shuts it down cleanly, and checks that an ingestion failure takes the
whole process down.

## Event coverage

All sixteen parseable registry events are ingested with their exact payload
fields, in the order `contracts/keeper-registry/src/events.rs` publishes them:

`TaskRegistered`, `ConditionNotMet`, `TaskClaimed`, `TaskExecuted`, `TaskExpired`,
`TaskCancelled`, `RewardIncreased`, `DeadlineExtended`, `RewardsWithdrawn`,
`Paused`, `FeeUpdated`, `AdminTransferred`, `MinRewardUpdated`, `FeesSwept`,
`Initialized`, `Upgraded`.

Fields the events do not carry are not reconstructed. `TaskClaimed` has no
reward, so a consumer needing the claim and the reward together joins against
the task's `TaskRegistered` event rather than reading an invented value. The
registration payload's optional `condition` is `null` for historical four-field
events, and each `ConditionNotMet` carries exactly `(task_id, condition)`.

## Caching

The aggregate queries the API exposes — currently the keeper leaderboard — are
served from a short-TTL cache (`src/cache.rs`).

| Variable | Default | Meaning |
|---|---|---|
| `INDEXER_CACHE_TTL_SECS` | `10` | Staleness bound for cached aggregates. `0` disables caching entirely. |

The TTL **is** the guarantee: no cached response is ever older than it. At the
default of 10 seconds, against a ~5s ledger close, a viewer can be at most two
ledgers behind — less than the time it takes to read the page.

A TTL is used rather than explicit invalidation because the event that would
invalidate the leaderboard (`task_executed`) is the one that arrives
continuously while the indexer is caught up: an invalidate-on-write cache would
spend most of its life empty, and would be emptiest exactly when traffic is
highest. Point lookups are not cached — their cost does not grow with traffic
the same way, and they are the reads most likely to be checked right after a
write.

## Schema migrations

The schema is versioned by [sqlx migrations](../indexer/migrations/) —
numbered SQL files, checked in and reviewed like any other code change
(issue #360). Which migrations have run against a given database is
recorded by sqlx itself, in that database's `_sqlx_migrations` table, with
a checksum per file: a committed migration that is edited after it shipped
is refused at startup rather than silently producing databases built from
different versions of the same "migration".

Applying them is one command either way:

- **On deploy, nothing** — `Store::connect` runs any pending migrations on
  every start.
- **Without starting an indexer** — ahead of a rollout, or against a
  restored backup:

  ```bash
  cargo run -p keeper-indexer --bin migrate -- sqlite://indexer.db
  # or with INDEXER_DATABASE_URL set, no argument needed
  ```

  The report lists every migration as `applied` / `already applied`, so a
  no-op run on a current database is visible as exactly that.

To add a migration: create `indexer/migrations/NNNN_short_name.sql` with
the next number, never edit a shipped one (add a corrective migration
instead), and let review read it like code — `tests/migrations.rs` pins
that a fresh database reaches the current schema in one step, that
migrating an existing database forward loses no data, and that a tampered
shipped migration is refused.
