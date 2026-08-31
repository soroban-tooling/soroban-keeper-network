---
title: "feat(keeper-bot-v2): process multiple tasks concurrently within a round"
labels: [keeper-bot, enhancement, advanced]
epic: E15
wave: 3
depends_on: [0250, 0252]
---

## Summary

v1's keeperLoop processes tasks from fetchPendingTasks one at a time in a simple loop, bounded by CONFIG.maxTasksPerRound. For a keeper competing on speed, serial claim-then-execute-then-move-to-next-task per candidate task is slower than necessary when the RPC round trips dominate wall-clock time.

## Expected behaviour

Concurrent handling of independent tasks within a round, bounded by a configurable concurrency limit, without exceeding the keeper's own resource or fee budget and without two concurrent workers ever attempting to claim the same task id.

## Suggested approach

Claim attempts are already independent and safe to race against other keepers per the contract's permissionless first-come-first-served design; the new risk this issue introduces is two workers in the same process racing each other, which the persistent state from issue 0252 should prevent by marking a task claimed-in-progress before the actual submission.

## Acceptance criteria

- [ ] Concurrency limit is configurable, defaulting to a conservative value.
- [ ] Two workers in the same process never submit competing claims for the same task id.
- [ ] A concurrency-bounded round completes correctly under a test with more candidate tasks than the configured limit.

## Files

- (v2 package)/src/loop.*
