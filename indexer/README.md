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
| `INDEXER_LOG` | no | `info` | `tracing` filter directive |

`INDEXER_START_LEDGER` should be the contract's deployment ledger. On a
network where that is not known exactly, any ledger at or before the
`initialize` call works: ingestion is idempotent, so starting early costs
extra scanning rather than correctness.

## Running

```bash
export INDEXER_RPC_URL=https://soroban-testnet.stellar.org
export INDEXER_CONTRACT_ID=C...
export INDEXER_DATABASE_URL=sqlite://indexer.db
export INDEXER_START_LEDGER=1000

cargo run -p keeper-indexer
```

## Tests

```bash
cargo test -p keeper-indexer
```

Tests run against an in-memory SQLite database and a fixture event source, so
no RPC endpoint or external database is needed.

## Event coverage

All fifteen events the contract emits are ingested with their exact payload
fields, in the order `contracts/keeper-registry/src/events.rs` publishes them:

`TaskRegistered`, `TaskClaimed`, `TaskExecuted`, `TaskExpired`,
`TaskCancelled`, `RewardIncreased`, `DeadlineExtended`, `RewardsWithdrawn`,
`Paused`, `FeeUpdated`, `AdminTransferred`, `MinRewardUpdated`, `FeesSwept`,
`Initialized`, `Upgraded`.

Fields the events do not carry are not reconstructed. `TaskClaimed` has no
reward, so a consumer needing the claim and the reward together joins against
the task's `TaskRegistered` event rather than reading an invented value.
