---
title: "feat(keeper-bot-v2): a real profitability check before claiming"
labels: [keeper-bot, enhancement, intermediate]
epic: E15
wave: 3
depends_on: [0250]
---

## Summary

Wave 1's issue 0041 asked for a check that skips tasks whose reward does not cover the cost of executing them; confirm whether that landed in v1 (examples/keeper-bot/index.js currently has no reference to a profitability comparison in its keeperLoop) and if not, implement the real version here, since v2 is explicitly aimed at operators for whom this matters more than it does for the simulated-execution demo path v1 defaults to.

## Expected behaviour

Before claiming, the bot estimates the total cost of claim plus execute plus an amortized withdrawal, reads the task's reward and the registry's current get_fee_bps to compute the net the keeper would actually receive, and skips the task if that net does not clear a configurable minimum profit margin.

## Suggested approach

Simulating the claim_task and execute_task calls gives a real resource-cost estimate rather than a hardcoded guess; use that where the timing allows (a task cannot be executed before it is claimed, so at minimum the claim's own simulated cost is known before submitting it, and the execute cost can be estimated from historical data or a placeholder proof simulation).

## Acceptance criteria

- [ ] A task whose net reward would not clear the configured minimum margin is skipped, not claimed and then abandoned.
- [ ] The margin and any hardcoded cost assumptions are configurable, following the same requireEnv validation discipline as v1's config.
- [ ] Skipped-for-profitability is logged distinctly from skipped-for-other-reasons, so an operator can tell whether the bot is idle for lack of tasks or for lack of profitable ones.

## Files

- (v2 package)/src/profitability.*
