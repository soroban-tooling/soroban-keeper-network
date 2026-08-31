---
title: "feat(indexer): handle a ledger being invalidated after ingestion"
labels: [indexer, enhancement, advanced]
epic: E14
wave: 3
depends_on: [0218, 0220]
---

## Summary

Implements whatever reorg-handling policy issue 0218 decided, whether that is genuine chain-reorganization defense or a narrower guard against an RPC node briefly reporting an inconsistent view.

## Expected behaviour

If a previously ingested ledger is later reported differently (or not at all) by the RPC source, the indexer detects the discrepancy and reconciles rather than silently keeping the stale data or crashing. The exact reconciliation strategy (roll back and re-ingest, flag for manual review) should match issue 0218's decision.

## Acceptance criteria

- [ ] The detection mechanism is implemented and testable without needing a real reorg to occur (a mock RPC source that changes its answer between two polls is sufficient).
- [ ] Reconciliation leaves the database in a state consistent with the RPC source's current view, not a mix of old and new data for the same ledger.
- [ ] The behavior matches issue 0218's stated policy; if that policy was "this is not a real risk on Stellar, treat any discrepancy as an RPC-node bug and alert rather than auto-reconcile," implement exactly that rather than building silent reconciliation issue 0218 explicitly ruled out.

## Files

- indexer/src/reorg.rs
