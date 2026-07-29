---
title: "perf(registry): investigate reducing save_task's per-call TTL-extension cost"
labels: [contract, intermediate]
epic: E05
wave: 2
depends_on: []
---

## Summary

save_task calls extend_ttl on every write, including writes that do not change ttl_ledgers at all (increase_reward, extend_deadline's own field change aside, claim_task, execute_task). Soroban's extend_ttl has a real resource cost even when the requested TTL is not actually increasing the entry's lifetime. This issue investigates whether save_task can skip the extension when it would be a no-op.

## Expected behaviour

Determine, empirically, whether Soroban's extend_ttl already short-circuits cheaply when the requested TTL is not an increase over the current one, or whether calling it unconditionally on every save_task is paying a real, avoidable cost. If the latter, add a cheap read-and-compare guard before calling extend_ttl.

## Suggested approach

This is exactly the kind of question issue 0100's per-entry-point resource report is built to answer -- measure save_task's cost before and after a guard, on a task whose TTL genuinely does not need extending, and let the numbers decide whether this is worth the added code complexity.

## Acceptance criteria

- [ ] The actual cost of a redundant extend_ttl call is measured, not assumed.
- [ ] If a guard is added, a test confirms it does not change behavior for a task that does need its TTL extended (no accidental early-archival regression).
- [ ] If the investigation finds no meaningful savings, that finding is recorded and no code change is made -- do not add complexity for an unmeasured benefit.

## Files

- contracts/keeper-registry/src/lib.rs
