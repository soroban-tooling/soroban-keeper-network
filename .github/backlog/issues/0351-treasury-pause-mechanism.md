---
title: "feat(treasury): decide whether the treasury needs its own pause switch"
labels: [contract, security, intermediate]
epic: E08
wave: 4
depends_on: [0338, 0340]
---

## Summary

The registry has a pause switch for incident response. This issue decides whether the treasury contract needs an analogous circuit breaker — for instance, to halt distribution if a recipient configuration is later discovered to be wrong or compromised — and implements it if so.

## Acceptance criteria

- [ ] A decision is recorded: a pause switch is added, following the registry's exact blocked-versus-allowed reasoning (block new distributions, keep any fund-recovery path open), or the decision is that the treasury's simpler surface does not need one and why.
- [ ] If added, the pause policy is documented in a table matching the registry's own pause doc-comment convention (wave 2 issue that added this table to admin.rs).
- [ ] Tests cover the pause behavior if implemented.

## Files

- contracts/treasury/src/lib.rs
