---
title: "feat(indexer): ingest treasury events"
labels: [indexer, enhancement, intermediate]
epic: E08
wave: 4
depends_on: [0343, 0220]
---

## Summary

Extends the indexer to ingest distribution and recipient-management events from issue 0343, exposing a revenue-accounting query surface a dashboard or a stakeholder can use to verify they received what they were owed.

## Acceptance criteria

- [ ] All treasury events are ingested with correct payload fields.
- [ ] A per-recipient distribution history query is available, matching the per-keeper activity query pattern from issue 0229.
- [ ] A derived total-distributed figure matches the treasury contract's own view (issue 0346) on a fully caught-up indexer.

## Files

- indexer/src/schema/treasury.sql
- indexer/src/ingest/treasury.rs
