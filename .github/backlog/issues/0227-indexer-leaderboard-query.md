---
title: "feat(indexer): a keeper leaderboard query"
labels: [indexer, enhancement, intermediate]
epic: E14
wave: 3
depends_on: [0221]
---

## Summary

A natural consumer of the keeper-events schema from issue 0221 is a ranked view of keepers by tasks executed, total net reward earned, or both, over a configurable time window. This is the data the web dashboard's leaderboard (epic E17) will need; building the query here means the dashboard consumes a ready endpoint rather than reimplementing the aggregation client-side.

## Expected behaviour

A query (exposed via the REST API from issue 0225) returning keepers ranked by execution count and by total net reward, each over all time and over a configurable recent window, with ties broken deterministically.

## Acceptance criteria

- [ ] Ranking by count and by total reward are both available, over all time and over a configurable window.
- [ ] Tie-breaking is deterministic and documented.
- [ ] Result matches a manual aggregation over the raw event data for a fixed test dataset.

## Files

- indexer/src/queries/leaderboard.rs
