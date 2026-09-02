---
title: "feat(keeper-bot): skip tasks whose verifier the bot cannot satisfy or afford"
labels: [keeper-bot, enhancement, intermediate]
epic: E04
wave: 2
depends_on: [0090, 0076]
---

## Summary

Companion to wave 1's profitability check (issue 0035) and to 0090: a bot should not claim a task it has no way to produce an acceptable proof for, or whose verifier's resource cost (per 0076's findings) would make execution unprofitable even if the base reward looks attractive.

## Expected behaviour

Before claiming, the bot checks (in order): does it have a proof-generation strategy registered for this task's verifier kind (per 0090's extension point)? If not, skip. If yes, does simulating the eventual `execute_task` call (including the verifier's cost) still clear the profitability threshold from wave 1's issue 0035? If not, skip.

## Suggested approach

This depends on 0076 having established that pre-claim simulation of the verifier's cost is actually feasible — if 0076 concludes it isn't, this issue's profitability half needs to fall back to a post-claim check instead (claim, simulate, and if unprofitable, let the lock lapse rather than executing) — coordinate with 0076's actual finding rather than assuming the ideal case.

## Acceptance criteria

- [ ] Bot skips tasks with an unrecognized verifier kind rather than attempting and failing.
- [ ] Bot factors verifier cost into the profitability decision, using whichever timing (pre- or post-claim) 0076 determined is feasible.
- [ ] Logged clearly when a task is skipped for either reason, so an operator can tell "no profitable tasks" from "tasks exist but this bot can't serve their verifiers."

## Files

- `examples/keeper-bot/index.js`
