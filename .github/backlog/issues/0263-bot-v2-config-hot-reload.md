---
title: "feat(keeper-bot-v2): reload configuration without a restart"
labels: [keeper-bot, enhancement, intermediate]
epic: E15
wave: 3
depends_on: [0250]
---

## Summary

v1 loads configuration once at startup via validateAndLoadConfig. An operator tuning profitability thresholds, concurrency limits, or fee ceilings in v2 should not need to restart the bot (losing in-flight state, even with persistence from issue 0252 to recover it) for every adjustment.

## Expected behaviour

A subset of configuration values, explicitly documented as hot-reloadable, can be changed and take effect on the next round without a process restart, while values that genuinely require a restart (the signing account, the network) are clearly distinguished from ones that do not.

## Acceptance criteria

- [ ] Hot-reloadable values are explicitly listed and take effect within one round of being changed.
- [ ] Restart-required values are explicitly listed and a change to them is detected and logged as requiring a restart, not silently ignored.
- [ ] A malformed reload (an invalid value) is rejected with the same validation the startup path already applies, not accepted and left to fail later.

## Files

- (v2 package)/src/config.*
