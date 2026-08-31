---
title: "design(indexer): a data retention and archival policy"
labels: [indexer, docs, intermediate]
epic: E14
wave: 3
depends_on: [0220, 0221, 0222]
---

## Summary

An indexer that never prunes anything grows without bound. This issue decides, before the database is large enough for the question to be urgent, whether raw event history is kept forever, archived to cold storage after some age, or aggregated and the raw rows dropped.

## Expected output

A written decision balancing the audit-trail value of full history (relevant to epic E19's security and audit readiness work) against storage cost, with a concrete plan if anything is archived or pruned: what triggers it, where archived data goes, and how a request for archived data would be served if one ever comes in.

## Acceptance criteria

- [ ] A decision is recorded with rationale, explicitly weighing audit-trail needs against cost.
- [ ] If archival or pruning is chosen, the mechanism is specified precisely enough to implement as a follow-up issue.
- [ ] If full retention forever is chosen, that is stated as a deliberate decision, not a default arrived at by omission.

## Files

- docs/INDEXER_DESIGN.md
