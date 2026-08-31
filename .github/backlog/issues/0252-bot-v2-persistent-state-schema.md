---
title: "feat(keeper-bot-v2): persistent task-state schema"
labels: [keeper-bot, enhancement, intermediate]
epic: E15
wave: 3
depends_on: [0250, 0251]
---

## Summary

v1's header comment names the gap directly: production keepers should add a persistent task state DB to avoid double-claiming, and v1's own in-memory taskOutcomes cache (issue 0135) is explicitly lost on every restart. This issue implements the durable version.

## Expected behaviour

A schema tracking, per task id this keeper has interacted with: what it has done (claimed, executed, expired), when, and the outcome, surviving a process restart. On startup, the bot loads this state before its first round so a restart does not attempt to re-claim or re-execute a task it already finished.

## Suggested approach

The in-memory taskOutcomes Map from issue 0135 is the direct model for what this schema needs to track; this issue is that same data made durable, not a redesign of what is tracked.

## Acceptance criteria

- [ ] State survives a process restart and is loaded before the first round runs.
- [ ] A restarted bot does not re-attempt a task it already executed or expired in a prior run.
- [ ] Schema migrations are supported from the start (reuse or mirror the approach from indexer issue 0232 rather than inventing a second migration mechanism in the same project).

## Files

- (v2 package)/src/state/schema.*
