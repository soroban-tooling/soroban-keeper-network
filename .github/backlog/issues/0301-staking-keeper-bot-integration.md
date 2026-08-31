---
title: "feat(keeper-bot-v2): stake before claiming, if a minimum is required"
labels: [keeper-bot, enhancement, intermediate]
epic: E06
wave: 4
depends_on: [0292, 0299]
---

## Summary

If issue 0292 established a minimum stake to claim tasks, keeper-bot-v2 (epic E15) needs to check and, if configured to do so, automatically maintain that minimum, rather than an operator discovering the requirement only when claim_task starts failing.

## Expected behaviour

At startup and periodically thereafter, the bot checks its current stake against the contract's configured minimum (via the view from issue 0297) and, if below and auto-staking is enabled in configuration, deposits enough to clear it; if auto-staking is disabled, it logs a clear warning rather than silently failing every claim attempt.

## Acceptance criteria

- [ ] A bot below the minimum stake either auto-stakes (if configured) or logs a specific, actionable warning, never a generic claim failure with no indication of the root cause.
- [ ] Auto-staking respects a configurable ceiling so the bot does not deposit more than an operator intended.
- [ ] If issue 0292 concluded no minimum is enforced, this issue is a no-op and should be closed noting that, not implemented speculatively against a requirement that does not exist.

## Files

- examples/keeper-bot-v2/src/staking.*
