---
title: "feat(governance): timelock delay between a proposal passing and taking effect"
labels: [contract, security, advanced]
epic: E09
wave: 4
depends_on: [0365]
---

## Summary

Implements the timelock issue 0360 specified, giving affected parties (task owners, keepers) time to react to a passed governance change before it actually takes effect.

## Expected behaviour

A passed proposal enters a queued state for the configured delay before it becomes executable, mirroring the claim_ledger-plus-lock_ledgers time-gating pattern already used elsewhere in this project, adapted to ledger-based (or timestamp-based, per issue 0360) delay.

## Acceptance criteria

- [ ] A passed proposal cannot execute before its timelock elapses, verified with boundary tests at delay-minus-one, exactly-at-delay, and delay-plus-one.
- [ ] The queued state and its remaining delay are queryable so an affected party can see exactly how much time remains to react.
- [ ] A test confirms the timelock cannot be bypassed by any other governance action, including a second proposal attempting to fast-track the first.

## Files

- contracts/governance/src/lib.rs
- contracts/governance/src/test.rs
