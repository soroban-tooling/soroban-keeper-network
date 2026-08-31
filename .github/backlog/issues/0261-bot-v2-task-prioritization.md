---
title: "feat(keeper-bot-v2): prioritize candidate tasks by expected net profit"
labels: [keeper-bot, enhancement, intermediate]
epic: E15
wave: 3
depends_on: [0254]
---

## Summary

v1 processes fetchPendingTasks in whatever order events were returned, bounded by maxTasksPerRound. When more profitable candidates exist than the round can process, processing order matters: the bot should attempt the most profitable candidates first, not an arbitrary or arrival order.

## Expected behaviour

Candidates are ranked by the expected net profit the calculation from issue 0254 already computes, and the round processes them in descending order until the round's budget (time, concurrency, or task count) is exhausted.

## Acceptance criteria

- [ ] Candidates are ranked before processing, not processed in arrival order.
- [ ] A round with more profitable candidates than its budget allows processes the most profitable ones, verified by a test with a mixed set of reward sizes.
- [ ] Ranking does not introduce enough latency to itself erode the profit margin it is trying to protect, for a realistic candidate count per round.

## Files

- (v2 package)/src/loop.*
