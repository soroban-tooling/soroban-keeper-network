---
title: "feat(indexer): a unified activity feed for one address"
labels: [indexer, enhancement, intermediate]
epic: E14
wave: 3
depends_on: [0220, 0221]
---

## Summary

An address can be a task owner, a keeper, or both. A user-facing dashboard page for one address needs a single chronological feed of everything that address has done — tasks it registered, tasks it claimed, tasks it executed, withdrawals it made — rather than the caller stitching together several separate queries.

## Expected behaviour

One endpoint taking an address and returning its full activity across both owner-role and keeper-role events, in chronological order, with each entry tagged by which role it occurred in.

## Acceptance criteria

- [ ] An address active in both roles shows correctly interleaved, role-tagged entries.
- [ ] Pagination behaves correctly for an address with a long history.
- [ ] A test confirms an address that has only ever been an owner (never claimed anything) still returns a correct, non-error feed.

## Files

- indexer/src/queries/activity.rs
