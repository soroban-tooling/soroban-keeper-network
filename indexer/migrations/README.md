# Indexer schema migrations

Versioned migration files, applied in order, with a record of what has run —
so deploying a schema change is one command, not a hand-edit of whatever
database instances happen to exist (issue 0232).

The tool is `sqlx`'s built-in migrator, per the design doc's storage
decision and the issue's own advice: this is a solved problem, and a custom
runner would only add maintenance burden. There is nothing bespoke to learn.

## How it works

- **Files**: `NNNN_short_name.sql` in this directory, ordered by the numeric
  prefix. Forward-only; a change of mind is a new migration, never an edit
  to an applied one (the checksum of every applied migration is recorded and
  re-verified — editing history fails loudly on the next run).
- **The record**: sqlx maintains a `_sqlx_migrations` table in the target
  database — version, description, checksum, applied-at — so any database
  can tell you exactly which migrations it has run, and re-running is a
  no-op for everything already applied.
- **Review**: migration files live in this repository and go through the
  same PR review as any other code change. Nothing reaches a database that
  did not reach `main` first.

## One command

Fresh database or existing one, the same command brings it to the current
schema and applies nothing twice:

```sh
DATABASE_URL=postgres://… cargo run -p keeper-indexer -- --migrate-only
```

`--migrate-only` validates `DATABASE_URL`, applies pending migrations,
prints what it did, and exits — usable from a deploy pipeline without RPC
configuration. The service also applies pending migrations on every normal
startup, so an ordinary deploy needs no separate step.

## Discipline for writing one

- Additive by strong preference: new tables, new nullable columns, new
  indexes. Destructive changes against live data need their own PR argument.
- `if not exists` / `if not exists`-style guards keep a migration safe to
  re-run against a database that acquired the object out of band.
- Data-preserving: `indexer/tests/migrations.rs` proves the tool applies a
  later migration over a database with live rows without losing them —
  keep it that way for the real files here.
