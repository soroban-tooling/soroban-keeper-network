---
title: "feat(indexer): schema and ingestion for admin and governance-adjacent events"
labels: [indexer, enhancement, intermediate]
epic: E14
wave: 3
depends_on: [0219]
---

## Summary

Implements storage and ingestion for the remaining events: Paused, FeeUpdated, AdminTransferred, MinRewardUpdated, FeesSwept, Initialized, and Upgraded. These are lower-volume than task events but matter for an audit trail: a dashboard or a security reviewer needs to see every fee change and every admin transfer in order, not just the current values.

## Expected behaviour

An admin-events table preserving full history (every FeeUpdated, not just the latest), plus a current-config view derived from the latest of each type, mirroring the same history-versus-derived-state split as issue 0220's task schema.

## Acceptance criteria

- [ ] All seven admin/governance events ingested with correct payload fields, including Upgraded's BytesN<32> wasm hash.
- [ ] Full history is queryable, not overwritten by later events of the same type.
- [ ] A current-config view (current fee_bps, current admin, current pause state, current min_reward) is correct after replaying a mixed sequence of these events.

## Files

- indexer/src/schema/admin.sql
- indexer/src/ingest/admin.rs
