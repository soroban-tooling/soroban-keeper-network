---
title: "feat(indexer): ingest reputation events and expose a derived score history"
labels: [indexer, enhancement, intermediate]
epic: E07
wave: 4
depends_on: [0324, 0220]
---

## Summary

Extends the indexer to ingest the reputation events from issue 0324, exposing both the raw history of updates and a derived current-score view, matching the history-plus-derived pattern issue 0220 established for task events.

## Acceptance criteria

- [ ] Reputation events are ingested with correct payload fields.
- [ ] A derived current-score view matches the contract's own keeper_reputation view on a fully caught-up indexer.
- [ ] The leaderboard query from issue 0227 is extended to optionally rank by reputation alongside its existing count and reward rankings.

## Files

- indexer/src/schema/reputation.sql
- indexer/src/ingest/reputation.rs
