---
title: "design(indexer): a policy for handling a future contract event shape change"
labels: [indexer, docs, intermediate]
epic: E14
wave: 3
depends_on: [0218]
---

## Summary

The contract's VERSION constant exists specifically because its ABI, including event shapes, can change across an upgrade. If a future upgrade changes an event's payload (adds a field, changes a type), the indexer's ingestion code for that event will either need to branch on contract VERSION or the indexer will misparse events from before or after the upgrade.

## Expected output

A written policy: does the indexer read the contract's VERSION at ingestion time and dispatch to a version-specific parser, does it require a coordinated indexer upgrade at the same time as any contract upgrade, or something else. Whichever is chosen, state what happens to already-ingested data from before the version change.

## Acceptance criteria

- [ ] The policy explicitly addresses parsing events from both before and after a hypothetical version change.
- [ ] If version-dispatch is chosen, the ingestion code from issues 0220 through 0222 is structured to support adding a new version's parser without rewriting the existing one.

## Files

- docs/INDEXER_DESIGN.md
