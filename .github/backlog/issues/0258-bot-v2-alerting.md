---
title: "feat(keeper-bot-v2): alerting on missed executions and persistent errors"
labels: [keeper-bot, observability, intermediate]
epic: E15
wave: 3
depends_on: [0257]
---

## Summary

v1's header lists PagerDuty/Telegram alerting on missed executions as a production addition. This issue implements it against the metrics from issue 0257.

## Expected behaviour

Configurable alert rules (a claimed task that was never executed within its lock window, a run of consecutive rounds with RPC errors, keeper balance not growing despite claimed activity) that notify an operator through a pluggable transport, following the same pluggable-transport reasoning as the indexer's alert hooks in issue 0240 rather than hardcoding one provider.

## Acceptance criteria

- [ ] The three stated conditions are detectable and trigger a notification.
- [ ] Transport is pluggable; a generic webhook is the minimal reference implementation.
- [ ] A test simulates each condition and confirms exactly one notification fires per incident, not a flood of duplicates for an ongoing condition.

## Files

- (v2 package)/src/alerts.*
