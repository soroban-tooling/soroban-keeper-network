---
title: "test(keeper-bot-v2): a simulated multi-keeper competition test harness"
labels: [keeper-bot, testing, advanced]
epic: E15
wave: 3
depends_on: [0261, 0270]
---

## Summary

Prioritization (issue 0261) and profitability logic (issue 0254) are only genuinely tested under realistic conditions if the test setup includes competition: other keepers claiming the same tasks. v1 and v2's existing tests run a single bot instance against a mocked RPC layer with no contention.

## Expected behaviour

A test harness running two or more bot instances (or one instance evaluated against a simulated environment where some tasks are claimed by a phantom competitor mid-round) to verify the bot correctly treats a lost claim race as a normal, non-error outcome (matching the existing comment in v1's keeperLoop stating exactly this) and moves on to the next candidate rather than stalling or misreporting the loss as a failure.

## Acceptance criteria

- [ ] A lost claim race is observably handled as success-with-skip, not logged or counted as an error.
- [ ] The bot continues processing remaining candidates in the same round after losing a race.
- [ ] Metrics from issue 0257 correctly distinguish a lost race from other skip reasons.

## Files

- (v2 package)/test/competition.*
