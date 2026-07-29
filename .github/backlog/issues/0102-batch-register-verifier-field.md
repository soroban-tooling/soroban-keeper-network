---
title: "feat(registry): thread the optional verifier field through batch_register_tasks"
labels: [contract, enhancement, intermediate]
epic: E05
wave: 2
depends_on: [0098, 0073]
---

## Summary

If epic E04's verifier field (issue 0073) lands before or alongside batch registration (issue 0098), TaskParams in the batch entry point needs the same optional verifier field register_task takes individually. This issue exists specifically to make sure that coordination happens deliberately rather than by accident of merge order.

## Expected behaviour

TaskParams gains verifier: Option<Address>, mirroring register_task's parameter exactly. Batch entries with different verifiers (including a mix of Some and None) are all valid.

## Suggested approach

If 0098 already merged before 0073, this is a small additive PR to TaskParams and the internal validation helper. If 0073 merged first, 0098's implementation should already include this field and this issue can be closed as satisfied by that PR -- check before starting work.

## Acceptance criteria

- [ ] TaskParams carries the same verifier field as register_task.
- [ ] A test registers a batch with a mix of verifier and no-verifier entries and confirms each task's field is set correctly.

## Files

- contracts/keeper-registry/src/lib.rs
- contracts/keeper-registry/src/test.rs
