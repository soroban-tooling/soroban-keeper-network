---
title: "feat(keeper-bot-v2): break down metrics by task_type"
labels: [keeper-bot, observability, good-first-issue]
epic: E15
wave: 3
depends_on: [0257, 0256]
---

## Summary

The metrics from issue 0257 are aggregate across all task types. An operator running executors (issue 0256) for several task types wants to see which ones are actually profitable and which are dead weight, which an aggregate counter cannot show.

## Acceptance criteria

- [ ] Claimed, executed, and skipped counts are broken down by task_type in addition to the existing aggregate totals.
- [ ] Net profit is tracked per task_type, not just overall.
- [ ] Adding a new executor for a new task_type automatically produces its own metrics breakdown without additional wiring.

## Files

- (v2 package)/src/metrics.*
