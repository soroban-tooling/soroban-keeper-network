---
title: "feat(keeper-bot-v2): a configurable withdrawal strategy beyond a fixed threshold"
labels: [keeper-bot, enhancement, good-first-issue]
epic: E15
wave: 3
depends_on: [0250]
---

## Summary

v1 withdraws whenever accrued balance crosses a fixed WITHDRAW_THRESHOLD. An operator managing withdrawal timing for tax, accounting, or liquidity reasons may want a different policy: a fixed schedule regardless of balance, or a threshold that also considers current network fees (withdrawing during a low-fee window even below the normal threshold).

## Expected behaviour

A pluggable withdrawal strategy interface with the current fixed-threshold behavior as the default, so v1's simplicity is preserved for anyone who does not need more, while v2 operators can supply an alternative.

## Acceptance criteria

- [ ] Default behavior matches v1's fixed-threshold approach exactly, so migrating from v1 to v2 with no configuration change does not alter withdrawal timing.
- [ ] At least one alternative strategy (a fixed schedule) is provided as a reference implementation of the interface.
- [ ] A test confirms the interface is genuinely pluggable, not hardcoded to the two provided strategies.

## Files

- (v2 package)/src/withdrawal.*
