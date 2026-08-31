---
title: "feat(indexer): ingest the staking events into their own schema"
labels: [indexer, staking, enhancement, intermediate]
epic: E06
wave: 4
depends_on: [0296, 0220]
---

## Summary

Extends the indexer (epic E14) to ingest the four staking events from issue 0296, following the same history-plus-derived-current-state pattern issue 0220 established for task events.

## Acceptance criteria

- [ ] All four staking events are ingested with correct payload fields.
- [ ] A derived current-stake view per keeper is correct after replaying a mixed sequence of deposit, unbond, withdraw, and slash events.
- [ ] The derived view matches the contract's own keeper_stake view exactly on a fully caught-up indexer, the same correctness check issue 0221 used for keeper balances.

## Files

- indexer/src/schema/staking.sql
- indexer/src/ingest/staking.rs
