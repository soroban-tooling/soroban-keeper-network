---
title: "design(registry): investigate whether escrow transfers can be batched across a batch_register_tasks call"
labels: [contract, intermediate]
epic: E05
wave: 2
depends_on: [0098]
---

## Summary

batch_register_tasks (issue 0098), as scoped, does one token transfer per task entry -- the same as calling register_task N times, just in one transaction. Each transfer is a cross-contract call to the reward token, which has its own resource cost. This issue investigates whether the N transfers can be collapsed into a single transfer of the total, held in an intermediate accounting step, or whether Soroban's token interface and this contract's escrow-per-task accounting model make that impractical.

## Expected behaviour

Either a concrete design for collapsing the transfers (if the reward token interface and accounting model allow it cleanly) or a documented reason why per-task transfers are necessary or not worth the added complexity to avoid.

## Suggested approach

The complication to reason through carefully: a single collapsed transfer would move `sum(rewards)` from the owner to the registry in one call, but each task still needs its own reward amount recorded and refundable independently later (via cancel_task or expire_task). That's an accounting change, not just a transfer-count change -- confirm it doesn't complicate the solvency invariant (I-1) or the per-task refund logic before recommending it.

## Acceptance criteria

- [ ] The accounting complication above is explicitly addressed.
- [ ] A resource-cost comparison (N transfers vs 1) is estimated, even roughly, to establish whether the complexity would even be worth it.
- [ ] A clear recommendation: implement, or leave as N separate transfers with the reasoning documented.

## Files

- docs/BATCH_OPERATIONS.md
