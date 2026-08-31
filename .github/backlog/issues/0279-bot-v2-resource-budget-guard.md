---
title: "feat(keeper-bot-v2): a hard ceiling on per-round resource spend"
labels: [keeper-bot, enhancement, intermediate]
epic: E15
wave: 3
depends_on: [0253, 0254]
---

## Summary

Concurrency (issue 0253) and prioritization (issue 0261) both increase how much a single round can attempt. Without an explicit ceiling, a misconfiguration or an unusually large candidate burst (issue 0270's batch scenario) could submit far more transactions in one round than an operator intended, in excess of what the profitability margin was sized to tolerate as an occasional loss.

## Expected behaviour

A configurable hard ceiling on total fee spend per round (not just task count), enforced independently of the profitability check, so a bug in profitability logic cannot alone cause runaway spend.

## Acceptance criteria

- [ ] A round stops submitting new transactions once the configured spend ceiling is reached, regardless of remaining candidates.
- [ ] The ceiling is enforced as a hard backstop independent of the profitability calculation, not merely a restatement of it.
- [ ] Reaching the ceiling is logged distinctly, since it likely indicates a configuration or market condition worth an operator's attention.

## Files

- (v2 package)/src/loop.*
