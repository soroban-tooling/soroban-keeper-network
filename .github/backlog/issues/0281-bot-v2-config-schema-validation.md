---
title: "feat(keeper-bot-v2): validate the full configuration schema at startup, including v2-only fields"
labels: [keeper-bot, enhancement, good-first-issue]
epic: E15
wave: 3
depends_on: [0250]
---

## Summary

v1's requireEnv validates each value individually as it is read. v2 adds enough new configuration (concurrency limits, profitability margins, database connection, secret manager settings from issue 0268) that validating the full set together, catching interactions between values a per-field check would miss, is worth doing explicitly.

## Expected behaviour

A startup validation pass that checks not just individual field validity but cross-field consistency: a concurrency limit higher than the account pool size from issue 0255 can actually support, a profitability margin that would reject every task at the current fee ceiling, and similar contradictions.

## Acceptance criteria

- [ ] At least two genuine cross-field inconsistencies are caught at startup with a clear error, not discovered at runtime.
- [ ] Per-field validation continues to follow v1's fail-fast, specific-reason discipline.
- [ ] A test suite of intentionally broken configurations confirms each is rejected with a message pointing at the actual problem.

## Files

- (v2 package)/src/config.*
