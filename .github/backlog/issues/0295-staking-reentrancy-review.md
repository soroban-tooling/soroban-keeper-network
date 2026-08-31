---
title: "security(registry): checks-effects-interactions review of every new staking entry point"
labels: [contract, security, advanced]
epic: E06
wave: 4
depends_on: [0289, 0290, 0291]
---

## Summary

Two of the contract's most serious historical bugs were CEI-ordering violations in cancel_task and expire_task (wave 1 issues 0002 and 0003, both eventually fixed by PRs that reordered the status write before the token transfer). Every new staking entry point that moves tokens (stake_deposit, withdraw_stake, slash) needs the same review before merge, not after a bug is found the same way those two were.

## Expected behaviour

Each of the three token-moving staking functions writes its state change before making the external token transfer, matching the corrected pattern in cancel_task and expire_task today, and each has a reentrancy regression test in the same style as the existing test/cancel.rs and test/expire.rs reentrant-token tests.

## Acceptance criteria

- [ ] stake_deposit, withdraw_stake, and slash all follow effects-before-interaction ordering, verified by reading the actual code, not assumed from the design doc.
- [ ] Each has a dedicated reentrancy regression test, named to its own scope (reentrant_token_stake, not a generically named module that could collide with the existing cancel/expire ones per the naming convention CONTRIBUTING.md documents).
- [ ] Findings are fixed before this issue closes, not filed as follow-ups, since these are new functions with no existing users to break.

## Files

- contracts/keeper-registry/src/staking.rs
- contracts/keeper-registry/src/test/staking.rs
