---
title: "feat(registry): reputation storage and incremental updates on task completion"
labels: [contract, enhancement, intermediate]
epic: E07
wave: 4
depends_on: [0318]
---

## Summary

Implements the storage and update logic issue 0318 designed: a per-keeper reputation record updated as a side effect of execute_task (a success) and whatever failure condition the design names (a lock window expiring without execution, tracked at the point re-claim happens).

## Acceptance criteria

- [ ] A reputation record is created on a keeper's first tracked action and updated correctly on every subsequent one.
- [ ] The update happens as an integrated part of the existing execute_task and claim_task flows, not a separate call an integrator could forget to make.
- [ ] A test drives a keeper through several successes and one missed window and confirms the stored record matches the expected computation from issue 0318's formula.

## Files

- contracts/keeper-registry/src/reputation.rs
- contracts/keeper-registry/src/task.rs
- contracts/keeper-registry/src/test/reputation.rs
