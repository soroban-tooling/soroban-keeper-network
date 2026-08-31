---
title: "feat(indexer): protocol-wide statistics query"
labels: [indexer, enhancement, intermediate]
epic: E14
wave: 3
depends_on: [0220, 0222]
---

## Summary

Beyond per-task and per-keeper views, a dashboard needs protocol-level numbers: total tasks registered, total value escrowed historically, current open escrow, total fees swept, current fee rate, and similar aggregates.

## Expected behaviour

A single stats endpoint returning these figures, computed from the ingested event history rather than requiring a live call to the contract for each one, so a dashboard can render a stats page from one indexer query.

## Acceptance criteria

- [ ] All stated aggregates are available from one query.
- [ ] Current open escrow matches the contract's actual token balance dedicated to open tasks, verified against a test deployment.
- [ ] The query performs acceptably as the event history grows; document the indexing strategy that keeps it fast rather than a full table scan per request.

## Files

- indexer/src/queries/stats.rs
