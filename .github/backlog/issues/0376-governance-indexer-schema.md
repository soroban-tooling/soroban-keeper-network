---
title: "feat(indexer): ingest the full governance event history"
labels: [indexer, enhancement, intermediate]
epic: E09
wave: 4
depends_on: [0369, 0220]
---

## Summary

Extends the indexer to track proposals end to end: creation, every vote cast, tallying, and execution, exposing a query surface a dashboard's governance page (epic E17) can build directly against.

## Acceptance criteria

- [ ] All governance events are ingested with correct payload fields.
- [ ] A per-proposal view assembles its full lifecycle (who created it, every vote, final tally, execution status) from the raw event history.
- [ ] A per-address voting history query is available, matching the activity-feed pattern from issue 0229.

## Files

- indexer/src/schema/governance.sql
- indexer/src/ingest/governance.rs
