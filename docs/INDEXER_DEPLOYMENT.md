# Deploying & Running the Indexer

How to stand up an indexer instance: what it needs, how to provision its
database, how to run the initial backfill, and what a healthy steady state
looks like.

This document is about *operating* an indexer. For what the indexer is, how
its schema is laid out, and why it stores history rather than mutable current
state, see [`INDEXER_DESIGN.md`](INDEXER_DESIGN.md) — that is the reference
for the design, and this guide does not restate it.

> **Note:** ingest, storage, reorg, backfill, and API-shape decisions from
> issue #346 still land in `INDEXER_DESIGN.md` as that issue closes. Until
> they do, the schema's own commented SQL in `indexer/src/schema/` is the
> reference for tables and columns. The instance model and event-versioning
> policy are already recorded there.

## One instance per deployment

One indexer process tracks exactly one registry contract, on one network.
That is a design decision ([`INDEXER_DESIGN.md` §1](INDEXER_DESIGN.md#1-one-instance-per-registry-deployment)),
not a current limitation that configuration can work around.

- **One `(network, contract id)` pair → one process, one database.** Testnet,
  futurenet, and mainnet each get their own instance. A second mainnet
  deployment after an upgrade or migration is a new pair, so it gets a new
  instance too.
- **Do not point two instances at the same database.** The schema has no
  contract-id column and the ingest checkpoint is a single row; two writers
  would share a cursor and mix unrelated history.
- **The contract id is a single `C...` value**, not a list. There is no
  supported way to pass several ids to one process.

An in-place WASM `upgrade` of the *same* contract id is still one
deployment: keep the same instance, same database, resume from the
checkpoint. The event-versioning policy in
[`INDEXER_DESIGN.md` §2](INDEXER_DESIGN.md#2-event-shape-changes-across-contract-version)
covers what happens to already-ingested rows and when a breaking event-shape
change instead means starting a new instance.

## Prerequisites

- **PostgreSQL 14 or newer.** The schema uses `NUMERIC(39, 0)` for the
  contract's `i128` amounts and `CREATE OR REPLACE VIEW`; nothing newer than
  14 is required.
- **A Rust toolchain**, to build the indexer binary (`cargo build --release
  --package keeper-indexer`).
- **An RPC endpoint** for the network the registry is deployed on, with
  retention covering the ledger range you intend to backfill (see
  [Initial backfill](#3-initial-backfill)).
- **The deployed registry contract ID** (`C...`) you want to index.

## 1. Provision the database

The indexer wants its own database and its own role. Give the role ownership
of its schema — the indexer creates its own tables on start — but no rights
over anything else on the instance.

```bash
createdb keeper_indexer
psql keeper_indexer -c "CREATE ROLE indexer LOGIN PASSWORD 'CHANGE_ME';"
psql keeper_indexer -c "GRANT ALL ON DATABASE keeper_indexer TO indexer;"
psql keeper_indexer -c "GRANT ALL ON SCHEMA public TO indexer;"
```

Sizing is driven by task events, not by the admin trail: admin and governance
events are low-volume by nature, while claims and executions grow with network
activity. Plan capacity against your expected task throughput, and note that
every event is retained — the indexer never deletes history to reclaim space.

The schema is applied by the indexer itself on start, and every statement is
`IF NOT EXISTS` / `OR REPLACE`, so starting against an existing database is
safe and is the normal case after the first run.

## 2. Configuration

The indexer is configured through the environment:

| Variable | Required | Meaning |
|----------|----------|---------|
| `DATABASE_URL` | Yes | `postgresql://indexer:PASSWORD@host:5432/keeper_indexer` |
| `RPC_URL` | Yes | The Soroban RPC endpoint to read events from. |
| `REGISTRY_CONTRACT_ID` | Yes | The single `C...` contract whose events are indexed. One id, not a list; a second contract is a second instance. |
| `START_LEDGER` | No | First ledger to backfill from. Defaults to the contract's deployment ledger. |

Keep `DATABASE_URL` out of shell history and out of the process table — it
carries the password. A systemd unit's `EnvironmentFile=` with mode `0600`, or
your platform's secret store, is the usual way.

## 3. Initial backfill

On an empty database the indexer replays history from `START_LEDGER` forward
before it begins following the chain head. This is the longest part of a
deployment and the part most likely to need a second attempt, so run it
attached the first time rather than as a service:

```bash
DATABASE_URL=... RPC_URL=... REGISTRY_CONTRACT_ID=C... \
  ./target/release/keeper-indexer --backfill
```

The backfill is **resumable and safe to re-run**. Every row is keyed on the
`(ledger, tx_index, event_index)` cursor the event was observed at, and every
insert is `ON CONFLICT DO NOTHING`, so re-ingesting a range that was already
processed is a no-op rather than a duplicate. If it dies partway, start it
again — it does not need the database reset first.

Once it reaches the chain head, start it as a long-running service to follow
live ledgers.

## 4. Steady-state operation

A healthy instance looks like this:

- **Ingestion lag is small and flat.** Lag is the distance between the latest
  ledger the indexer has ingested and the current chain head. It should sit at
  a few ledgers and stay there. A number that grows monotonically is the
  signal that matters — see the troubleshooting section.
- **Derived balances agree with the contract.** For any keeper address, the
  `available_balance` column of the `keeper_balances` view must equal the
  contract's own `keeper_balance` view whenever the indexer is caught up. This
  is the single best end-to-end correctness check, because it exercises
  ingestion, the schema, and the derived arithmetic at once:

  ```bash
  psql "$DATABASE_URL" -c \
    "SELECT available_balance FROM keeper_balances WHERE keeper = 'G...';"
  stellar contract invoke --id "$REGISTRY_CONTRACT_ID" -- keeper_balance --keeper G...
  ```

  A disagreement means the indexer is behind or has missed events; it does not
  mean the contract is wrong.
- **The admin trail is append-only.** Row counts in `admin_events` only ever
  increase. A count that drops means something outside the indexer wrote to
  the database.

Back up the database like any other stateful service. The data is
reconstructible from chain by re-running the backfill, so a backup is a
recovery-time optimization rather than the only copy — but a full re-backfill
is slow enough that you want the backup.

## Troubleshooting

### Backfill stuck partway

The ingested ledger stops advancing while the backfill is running.

Check the RPC endpoint first. The most common cause is that it does not retain
history as far back as `START_LEDGER`: public endpoints often keep a limited
window, and a request for an older ledger fails rather than returning an empty
result. Point at an endpoint with full history, or raise `START_LEDGER` and
accept that events before it are not indexed.

If the endpoint is fine, the backfill is safe to simply restart — it resumes
from what is already stored and re-ingesting overlapping ledgers is a no-op.
Do **not** drop the tables to "start clean"; that turns a resumable job into a
full replay.

### Ingestion lag growing

Lag increases steadily instead of holding flat, meaning the indexer is
consuming ledgers slower than the network produces them.

In order of likelihood:

1. **The database is the bottleneck.** Check for lock contention and slow
   inserts (`pg_stat_activity`). An under-provisioned instance, or one where
   the indexer competes with heavy analytical queries against the same
   tables, will show up here first.
2. **The RPC endpoint is rate-limiting or slow.** A shared public endpoint
   under load will throttle. Move to a dedicated endpoint.
3. **A restart loop.** If the process is crashing and restarting, lag grows
   between restarts even though each run makes progress. Check the service
   logs before assuming a throughput problem.

Lag that is large but *flat* after a restart or an outage is not this problem
— that is the indexer catching up, and it will close on its own.

### Database connection failures

The indexer cannot connect, or drops its connection during operation.

Verify the parts of `DATABASE_URL` independently — connect with `psql` using
the same URL. That separates a credentials or permissions problem from a
network one. If `psql` works and the indexer does not, the URL the process
actually received is not the one you think it is; check the environment file
is being read and has the right ownership.

For connections that succeed and then drop, look at the instance's connection
limit and at any idle-connection timeout between the indexer and the database
(a load balancer or connection pooler in between is the usual culprit). The
indexer reconnects on its own; persistent drops mean the limit or the timeout
needs raising, not a code change.

A connection failure never corrupts what is already stored — the indexer
resumes from the last committed cursor.
