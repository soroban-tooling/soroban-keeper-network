---
title: "test(registry): confirm every staking entry point returns NotInitialized before initialize"
labels: [testing, contract, good-first-issue]
epic: E06
wave: 4
depends_on: [0289, 0290, 0291]
---

## Summary

Wave 1's issue 0008 replaced panics with a typed NotInitialized error across the original entry points, with dedicated coverage in test/not_initialized.rs. The staking entry points added by this epic need the same coverage from the start rather than being an unaudited gap.

## Acceptance criteria

- [ ] stake_deposit, initiate_unbond, withdraw_stake, and slash all return NotInitialized (not a panic, not a different error) when called against a registry that has never been initialized.
- [ ] Tests are added to test/not_initialized.rs alongside the existing coverage, not a separate parallel file.

## Files

- contracts/keeper-registry/src/staking.rs
- contracts/keeper-registry/src/test/not_initialized.rs
