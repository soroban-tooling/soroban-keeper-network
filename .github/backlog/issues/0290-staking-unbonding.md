---
title: "feat(registry): unbonding delay for stake withdrawal"
labels: [contract, enhancement, intermediate]
epic: E06
wave: 4
depends_on: [0288, 0289]
---

## Summary

Implements whichever unbonding policy issue 0288 decided: if a delay is required, a keeper requesting to withdraw stake must wait a configured number of ledgers before the funds are actually releasable, so a keeper cannot deposit, misbehave, and instantly withdraw before a dispute (issue 0293) can be raised against it.

## Expected behaviour

An initiate_unbond(keeper, amount) entry point starting the delay, and a withdraw_stake(keeper) entry point that only succeeds once the delay has elapsed for the requested amount, mirroring the claim_ledger plus lock_ledgers pattern task claiming already uses for time-based eligibility.

## Acceptance criteria

- [ ] Stake requested for unbonding is not withdrawable before the configured delay elapses.
- [ ] A keeper cannot claim, execute, or otherwise use stake that is mid-unbond as if it were still fully backing its activity, if issue 0288's design ties any behavior to current effective stake.
- [ ] Boundary tests at delay-minus-one, exactly-at-delay, and delay-plus-one, following the same boundary-testing discipline as the existing lock_expired tests.

## Files

- contracts/keeper-registry/src/staking.rs
- contracts/keeper-registry/src/test/staking.rs
