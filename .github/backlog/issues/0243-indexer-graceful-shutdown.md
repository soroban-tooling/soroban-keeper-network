---
title: "fix(indexer): drain in-flight ingestion on shutdown instead of losing progress"
labels: [indexer, correctness, good-first-issue]
epic: E14
wave: 3
depends_on: [0219]
---

## Summary

The keeper-bot example already implements graceful shutdown that drains an in-flight round rather than exiting mid-operation (its SIGINT/SIGTERM handling). The indexer needs the equivalent: an ingestion cycle in progress when a shutdown signal arrives should finish and checkpoint cleanly rather than leaving a partially-ingested ledger's worth of events in an inconsistent state.

## Expected behaviour

On SIGINT or SIGTERM, the indexer stops accepting new ingestion cycles, allows the current one to complete and checkpoint, then exits, with a bounded maximum wait so a stuck cycle cannot prevent shutdown indefinitely.

## Acceptance criteria

- [ ] A shutdown signal during an in-flight ingestion cycle results in that cycle completing and checkpointing before exit.
- [ ] A configurable maximum drain time bounds how long shutdown can take.
- [ ] A test simulates a shutdown signal mid-cycle and confirms no partial or duplicate data results, building on issue 0230's idempotency guarantee as the fallback if a clean drain is not possible in time.

## Files

- indexer/src/main.rs
