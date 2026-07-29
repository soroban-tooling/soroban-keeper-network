---
title: "design(registry): feasibility study -- batch cancel for an owner's own pending tasks"
labels: [contract, docs, intermediate]
epic: E05
wave: 2
depends_on: [0099]
---

## Summary

Issue 0099 studied batch claim and batch execute and found them risky due to cross-keeper race conditions. cancel_task has none of that risk profile -- it is single-owner, single-auth, and only ever affects Pending (or, per issue 0133-style lock-lapsed Claimed, owner-controlled) tasks the caller already owns. This issue asks whether a batch_cancel_tasks is worth building, since the atomicity concerns from 0099 mostly do not apply here.

## Expected behaviour

A short analysis: is there real demand for cancelling many of one's own tasks at once (e.g. a dApp winding down a stale batch of liquidation-watch tasks), and if so, is the implementation as simple as it looks (loop the existing single-task validation and refund logic, all under one owner auth), or does something about the CEI ordering discussion from issues 0002/0057 make batching the refunds together more delicate than it first appears (e.g. a batch of N refunds is N token transfers in one transaction -- does that change the reentrancy analysis at all)?

## Acceptance criteria

- [ ] The reentrancy question above is explicitly addressed, not assumed away because "cancel_task is simple."
- [ ] A recommendation is made: build it, or explain why it is not worth the complexity relative to just calling cancel_task N times.
- [ ] If recommended, filed as its own implementation issue.

## Files

- docs/BATCH_OPERATIONS.md
