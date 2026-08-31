---
title: "test(indexer): ingestion is idempotent under duplicate delivery"
labels: [indexer, testing, intermediate]
epic: E14
wave: 3
depends_on: [0219, 0220]
---

## Summary

Whatever ingest mechanism issue 0218 chose, RPC sources can redeliver an event the indexer already processed (a retried poll after a timeout whose response actually succeeded, an at-least-once streaming guarantee). Ingestion must not double-count a redelivered event.

## Expected behaviour

Each event has a stable, unique identifier (contract id, ledger sequence, and event position within the ledger is a reasonable candidate) that ingestion uses to detect and skip a duplicate rather than inserting it twice or double-applying its effect to a derived view.

## Acceptance criteria

- [ ] A test feeds the same event to the ingestion path twice and confirms the resulting stored state is identical to feeding it once.
- [ ] The uniqueness key is documented and stable across the backfill and steady-state ingestion paths from issues 0223 and 0219.
- [ ] Derived views (keeper balances, task status) are also verified unaffected by the duplicate, not just the raw event table.

## Files

- indexer/src/ingest/mod.rs
- indexer/tests/idempotency.rs
