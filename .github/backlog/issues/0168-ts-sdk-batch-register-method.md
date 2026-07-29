---
title: "feat(sdk-ts): client.batchRegisterTasks, once epic E05's batch entry point ships"
labels: [enhancement, intermediate]
epic: E12
wave: 3
depends_on: [0098, 0153]
---

## Summary

Conditional on epic E05's `batch_register_tasks` (issue 0098) having landed on the contract by the time this is picked up. Adds the SDK-side typed wrapper, following the same per-entry shape as `registerTask` (issue 0154) but accepting an array and the `maxTotalReward` ceiling from issue 0103.

## Expected behaviour

`client.batchRegisterTasks({ owner, tasks: TaskParams[], maxTotalReward })` returning the array of new task ids in input order, matching the contract's documented ordering guarantee.

## Acceptance criteria

- [ ] Task id ordering matches input ordering, tested explicitly.
- [ ] Client-side pre-check that the sum of `tasks[].reward` does not exceed `maxTotalReward`, to fail fast before building a transaction.
- [ ] If the contract-side batch entry point has not shipped by the time this is picked up, this issue should be deferred rather than implemented against a guessed API shape.

## Files

- packages/sdk-ts/src/methods/batchRegisterTasks.ts
