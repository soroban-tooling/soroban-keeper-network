---
title: "test(registry): CPU-instruction regression ceilings for the staking entry points"
labels: [testing, contract, good-first-issue]
epic: E06
wave: 4
depends_on: [0289, 0290, 0291]
---

## Summary

Following the pattern issue 0107's ceilings established for claim_task and execute_task, the new staking entry points (particularly slash, which may involve a dispute-resolution lookup) need their own measured CPU-instruction baselines so a future refactor that regresses their cost is caught rather than silently shipped.

## Acceptance criteria

- [ ] Baseline CPU instructions are measured for stake_deposit, initiate_unbond, withdraw_stake, and slash.
- [ ] Ceilings are set at a documented multiple of the measured baseline, matching the reasoning already recorded in test/perf.rs for the existing two.
- [ ] Tests fail loudly if a future change pushes any of the four past its ceiling.

## Files

- contracts/keeper-registry/src/test/perf.rs
