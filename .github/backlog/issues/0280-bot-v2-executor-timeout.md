---
title: "fix(keeper-bot-v2): bound how long an off-chain executor may run"
labels: [keeper-bot, correctness, good-first-issue]
epic: E15
wave: 3
depends_on: [0256]
---

## Summary

v1's executeTaskOffChain calls a task's executor with no timeout. A hung or slow third-party executor (issue 0256's registered plugins) could stall a claimed task past its lock window, wasting the exclusive claim window without ever submitting execute_task.

## Expected behaviour

Executors run under a configurable timeout; a timed-out executor is treated as a failure for that task, freeing the bot to move on rather than blocking the round indefinitely.

## Acceptance criteria

- [ ] An executor exceeding the configured timeout is aborted and treated as a failed execution attempt.
- [ ] The round continues processing other candidates after an executor timeout, matching the existing per-task try/catch isolation in v1's keeperLoop.
- [ ] The timeout is configurable per task_type where different executors have genuinely different expected durations.

## Files

- (v2 package)/src/executors/interface.*
