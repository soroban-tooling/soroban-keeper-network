# Indexer database schema reference

The indexer's SQLite database (`indexer/migrations/*.sql`, applied by
`sqlx::migrate!` in `Store::connect` — see `indexer/src/store.rs`) is what
the REST and WebSocket APIs actually read from. This document describes it
table by table, and how the current-state views the API returns (a task's
live status, a keeper's balance, the current admin config) relate to it.
For the higher-level design rationale, see
[`INDEXER_DESIGN.md`](./INDEXER_DESIGN.md).

**This is generated from `indexer/migrations/`, not the other way
around** — if this document and the migrations ever disagree, the
migrations are right. A test,
`store::tests::schema_matches_docs_indexer_schema_md` in
`indexer/src/store.rs`, introspects a freshly migrated database (table
and column names, via `sqlite_master`/`pragma_table_info`) and asserts it
matches exactly the tables and columns documented below — a migration
that adds, removes, or renames one without this document being updated
fails that test, per issue 0372's acceptance criterion. It cannot check
prose (a column's *meaning*, as opposed to its name), so update both
together by hand regardless.

## Design: history first, state derived

One append-only `events` table is the source of truth for every registry
event the indexer has ingested. There is no separate `tasks`, `keepers`, or
`admin_config` table holding mutable current state — a task's live reward,
a keeper's live balance, and the current fee are all **computed by folding
the relevant rows of `events`** at query time (`TaskState::fold`,
`KeeperSummary::fold`, `AdminConfig::fold` in `indexer/src/state.rs`, called
from the `Store::task_state`/`keeper_summary`/`admin_config` methods below),
never kept as mutable columns a later event could drift out of sync with.
This is why every REST response and WebSocket message carries an event's
full history-relevant shape rather than a precomputed summary: the summary
*is* the history, folded.

## Tables

### `events`

The one table every other table and every derived view is built from.

| Column | Type | Meaning |
|---|---|---|
| `cursor` | `INTEGER PRIMARY KEY AUTOINCREMENT` | Monotonic ingestion sequence, assigned once on insert and never renumbered. This is the REST `/events` feed's `next_cursor` pagination cursor and the WebSocket `/v1/stream`'s `after`/`replayed_through` resume point — stable across ingestion happening between two requests, unlike an offset. |
| `ledger` | `INTEGER NOT NULL` | The ledger this event was emitted in. |
| `ledger_close_time` | `INTEGER NOT NULL` | That ledger's close time, Unix seconds. |
| `tx_hash` | `TEXT NOT NULL` | Transaction hash, hex-encoded. |
| `event_index` | `INTEGER NOT NULL` | Index of this event within its transaction. |
| `event_type` | `TEXT NOT NULL` | The event's wire name (`task_registered`, `task_claimed`, ..., all fifteen registry events — see the root README's event table). |
| `task_id` | `INTEGER`, nullable | Denormalised out of `payload` for events that carry one, so the API can filter by task without decoding every row's payload. `NULL` for an event with no task (e.g. an admin event). |
| `owner_address` | `TEXT`, nullable | Denormalised the same way, for events carrying a task owner. |
| `keeper_address` | `TEXT`, nullable | Denormalised the same way, for events carrying a keeper. |
| `payload` | `TEXT NOT NULL` | The event's full typed payload as JSON, exactly the shape the REST feed and WebSocket feed both emit (`IndexedEvent.payload` in `indexer/openapi.yaml`) — decoding it once at ingestion and storing the result means neither API surface needs its own second parser. |

Constraints and indexes:
- `UNIQUE (tx_hash, event_index)` is the idempotency guarantee: re-ingesting
  an already-seen emission — from an overlapping backfill page or a retried
  poll — is a no-op rather than a duplicate row.
- `idx_events_ledger`, `idx_events_type` support the REST feed's filters.
- `idx_events_task`, `idx_events_owner`, `idx_events_keeper` are partial
  indexes (`WHERE ... IS NOT NULL`) over the three denormalised columns,
  backing `task_history`/`task_ids_by_owner`/`task_ids_by_keeper`.
- `idx_events_keeper_time` is a covering index over
  `(keeper_address, ledger_close_time)`, specifically for the leaderboard
  and keeper-balance queries, which both scan a keeper's executions over a
  time window and would otherwise have to touch the `payload` blob per row.

### `ingest_checkpoint`

Single-row table recording ingestion progress, so an interrupted backfill
or a restart resumes from where it stopped rather than re-walking from the
configured start ledger.

| Column | Type | Meaning |
|---|---|---|
| `id` | `INTEGER PRIMARY KEY CHECK (id = 1)` | Always `1` — the `CHECK` is what enforces "single row". |
| `last_ledger` | `INTEGER NOT NULL` | Highest ledger fully ingested; every event at or below it is stored. |
| `backfill_complete` | `INTEGER NOT NULL DEFAULT 0` | `0`/`1` boolean (SQLite has no native boolean type). `1` once the historical walk has reached the chain tip at least once — the service uses this to decide backfill-mode vs. steady-state polling. |
| `updated_at` | `INTEGER NOT NULL` | When this checkpoint was last written. |

Exposed via `Store::checkpoint`/`save_checkpoint`, and via the REST
`/health` response's `backfill_complete`/`last_ingested_ledger` fields.

### `ledger_fingerprints`

Per-ledger content fingerprints, so a ledger the RPC source later reports
*differently* is detected rather than silently absorbed (reorg/RPC-view
discrepancy detection, issue 0224). A row is written the first time a
ledger is observed and **never updated** — on a disagreement, the original
is the only evidence the two views ever differed, so overwriting it would
destroy exactly the thing this table exists to preserve.

| Column | Type | Meaning |
|---|---|---|
| `ledger` | `INTEGER PRIMARY KEY` | The ledger this fingerprint covers. |
| `event_count` | `INTEGER NOT NULL` | How many events the source reported for this ledger, at first sight. |
| `digest` | `INTEGER NOT NULL` | An order-independent digest over the ledger's events. Stored as `INTEGER` (SQLite has no unsigned type); read back through the same cast it was written with. |
| `first_seen_at` | `INTEGER NOT NULL` | When this fingerprint was recorded. |

### `api_keys`

Optional API keys for cost-sensitive endpoints (bulk export, a higher rate
limit) — the core read endpoints stay public without one.

| Column | Type | Meaning |
|---|---|---|
| `key_id` | `TEXT PRIMARY KEY` | Public identifier, safe to log or quote in a support conversation. Carried inside the issued secret, so verification is a primary-key lookup rather than a scan-and-compare across every stored key. |
| `label` | `TEXT NOT NULL` | Which consumer this key was issued to. |
| `secret_hash` | `TEXT NOT NULL` | A digest of the secret, never the plaintext — a database dump (backup, leaked replica, an over-broad support query) must not hand out a working credential. The plaintext exists only at issuance. |
| `rate_limit_per_minute` | `INTEGER NOT NULL` | Requests per minute this key is allowed, above the anonymous default. |
| `created_at` | `INTEGER NOT NULL` | When the key was issued. |
| `revoked_at` | `INTEGER`, nullable | `NULL` while the key is live; set on revocation. Read on every request, so a revocation takes effect immediately rather than after a cache TTL expires. |

`idx_api_keys_live` is a partial index (`WHERE revoked_at IS NULL`) over
`key_id`, for the hot path of checking whether a presented key is still
valid.

## Raw events → derived views

Every "current state" shape the API returns is a fold over `events`, never
a separately maintained table:

| API shape | `Store` method | Folded from |
|---|---|---|
| `TaskDetail`/`TaskState` (`GET /tasks/{task_id}`) | `task_state` → `task_history` | Every `events` row with that `task_id`, oldest first. |
| `TaskListResponse` (`GET /owners/{owner}/tasks`, `GET /keepers/{keeper}/tasks`) | `task_ids_by_owner`/`task_ids_by_keeper` | `DISTINCT task_id` over rows matching `owner_address`/`keeper_address`. |
| `KeeperSummary` (used by the leaderboard) | `keeper_summary` | Every `events` row with that `keeper_address`, oldest first. |
| `AdminConfig` (`GET /admin/config`) | `admin_config` | Every `events` row whose `event_type` is one of the seven admin/governance events (`initialized`, `paused`, `fee_updated`, `admin_transferred`, `min_reward_updated`, `fees_swept`, `upgraded`). |
| `EventFeedResponse` (`GET /events`) / WebSocket `event` messages | `events_after` | A direct page of `events`, not folded — this *is* the raw history, which is what makes every fold above reproducible from it. |

A consumer deciding whether to call the REST API or query this database
directly: the API gives you the fold already computed and is the
supported, stable surface (`indexer/openapi.yaml`); querying `events`
directly gives you the raw history the fold is computed from, useful for a
custom aggregate the API doesn't expose (`indexer/src/queries/` is where
that kind of aggregate — e.g. the leaderboard — already lives, worth
checking before writing a new one against raw SQL).
