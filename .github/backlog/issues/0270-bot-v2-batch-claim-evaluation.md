---
title: "feat(keeper-bot-v2): evaluate batch_register_tasks-created tasks correctly"
labels: [keeper-bot, enhancement, intermediate]
epic: E15
wave: 3
depends_on: [0250]
---

## Summary

batch_register_tasks (contracts/keeper-registry/src/batch.rs) emits a normal TaskRegistered event per task in the batch, so tasks created this way are already discoverable through v1's existing event scan. This issue is specifically about correctness under batch-created volume: a single batch call can register up to MAX_BATCH_SIZE tasks in one transaction, meaning a keeper bot's fetchPendingTasks can see a large burst of new candidates in one poll rather than the steady trickle a naive implementation might assume.

## Expected behaviour

The bot's candidate evaluation, prioritization (issue 0261), and profitability check (issue 0254) all handle a burst of many simultaneous candidates from one batch registration correctly and without a performance cliff, verified against a batch at or near MAX_BATCH_SIZE.

## Acceptance criteria

- [ ] A round handles a burst of MAX_BATCH_SIZE simultaneous new candidates without a disproportionate slowdown relative to the same number of candidates arriving one at a time across several rounds.
- [ ] Prioritization and profitability checks apply identically regardless of whether a candidate came from a single-task registration or a batch.
- [ ] A test constructs a batch of tasks with a deliberate mix of profitable and unprofitable rewards and confirms only the profitable ones are claimed.

## Files

- (v2 package)/src/loop.*
