---
title: "feat(keeper-bot-v2): a richer, discoverable executor plugin interface"
labels: [keeper-bot, enhancement, intermediate]
epic: E15
wave: 3
depends_on: [0250]
---

## Summary

v1's executor pattern is two hardcoded functions (ttlExtensionExecutor, simulatedExecutor) selected inline. v2, aimed at real operators, needs executors to be pluggable in the sense the term implies: registered independently, discoverable by task_type, and loadable without editing the bot's own source.

## Expected behaviour

An executor interface any module can implement and register (by task_type) at startup from a configured list, so an operator adds support for a new task type by writing and pointing the bot at a new module rather than forking the bot's source.

## Suggested approach

The interface contract from v1 (an executor takes a task and returns a proof, or indicates it cannot handle the task) is the right shape to keep; this issue is about how executors are registered and discovered, not about redesigning what an executor does.

## Acceptance criteria

- [ ] An executor is a self-contained module implementing a documented interface.
- [ ] The bot loads a configured list of executor modules at startup and dispatches by task_type.
- [ ] A task whose type has no registered executor is skipped with a clear log message, matching v1's existing behavior of never fabricating a proof for a type it cannot handle.
- [ ] At least one real (non-simulated) executor is provided as a reference implementation, covering a genuinely useful task type.

## Files

- (v2 package)/src/executors/interface.*
