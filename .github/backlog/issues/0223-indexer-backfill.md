---
title: "feat(indexer): backfill from contract genesis on first run"
labels: [indexer, enhancement, advanced]
epic: E14
wave: 3
depends_on: [0220, 0221, 0222]
---

## Summary

A freshly started indexer needs every event since the contract's initialize call, not just events from the moment it started polling. This issue implements the one-time catch-up path issue 0218's design document specified.

## Expected behaviour

On first run against an empty database, the indexer walks forward from the contract's deployment ledger (or a configured start ledger, for a network where the exact deployment point is not known) ingesting every historical event before switching to steady-state polling. Progress is checkpointed so an interrupted backfill resumes rather than restarting from genesis.

## Suggested approach

This can reuse the same per-event ingestion logic from issues 0220 through 0222 rather than a separate backfill-specific parser; the only difference from steady-state ingestion is the ledger range being walked and the absence of a live polling delay between pages.

## Acceptance criteria

- [ ] A fresh database backfills correctly from a configured start ledger.
- [ ] Backfill progress is checkpointed and resumes correctly after an interruption partway through.
- [ ] After backfill completes, the indexer's derived current-state views (task status, keeper balances, current fee) match the contract's own views exactly.
- [ ] Backfill and steady-state ingestion share the same per-event parsing code, not two independent implementations that could drift.

## Files

- indexer/src/backfill.rs
