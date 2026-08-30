# Keeper Indexer

The event indexer for the `keeper-registry` contract — epic E14. The design
this service implements is `docs/INDEXER_DESIGN.md`; read that first. This
crate is currently the **scaffold** (issue 0219): it proves the plumbing —
config validation, database + migrations, RPC health, the paginated ingest
loop — and logs every raw event it observes without parsing or storing it.
The schema and per-event ingestion land with the follow-up issues.

## Run

```sh
INDEXER_RPC_URL=https://soroban-testnet.stellar.org \
INDEXER_CONTRACT_ID=C... \
DATABASE_URL=postgres://user:pass@localhost:5432/keeper_indexer \
INDEXER_START_LEDGER=1000 \
cargo run -p keeper-indexer
```

Startup order is deliberate: configuration is validated first (every failure
names the variable and the reason, and never echoes the database URL — the
same discipline as the keeper bot's `requireEnv`), then Postgres is connected
and migrations run, then the RPC endpoint is health-checked, and only then
does the loop start. A service that cannot store or reach the chain refuses
to boot rather than crashing on first use.

## Configuration

| Variable | Required | Meaning |
| --- | --- | --- |
| `INDEXER_RPC_URL` | yes | Soroban RPC endpoint (https; http for localhost only) |
| `INDEXER_CONTRACT_ID` | yes | The registry contract to observe (`C…` strkey) |
| `DATABASE_URL` | yes | Postgres connection string (never echoed in errors) |
| `INDEXER_START_LEDGER` | yes | First ledger to scan — the contract's deployment ledger |
| `INDEXER_POLL_INTERVAL_MS` | no | Sleep between rounds once caught up (default 10000, min 1000) |

## The loop

One code path for backfill and steady state, per the design: the first
request of a run uses `INDEXER_START_LEDGER`, every later request uses the
cursor the RPC returned (the two parameters are mutually exclusive), every
page is followed before sleeping, and a short page means caught up. A
persisted cursor arrives with the schema issues — the scaffold intentionally
re-observes from the start ledger on restart, which is safe precisely
because it stores nothing yet.

## Tests

`cargo test -p keeper-indexer` — config validation (including the
secret-redaction contract) and RPC response decoding. Nothing here needs a
database or network.
