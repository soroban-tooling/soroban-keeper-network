---
title: "feat(registry): stake storage and the stake_deposit entry point"
labels: [contract, enhancement, intermediate]
epic: E06
wave: 4
depends_on: [0288]
---

## Summary

Implements the first concrete piece of issue 0288's design: a keeper can post a stake, tracked in its own storage key separate from KeeperReward, so a bug in reward accounting can never accidentally touch stake and vice versa — the same separation-of-concerns reasoning that already keeps FeesAccrued distinct from task escrow.

## Expected behaviour

A stake_deposit(keeper, amount) entry point requiring the keeper's own auth, escrowing amount from the keeper into the contract, and a keeper_stake(keeper) -> i128 view mirroring the existing keeper_balance view's shape.

## Acceptance criteria

- [ ] Stake is stored under its own DataKey variant, never conflated with KeeperReward.
- [ ] Depositing requires the depositing keeper's own auth; no address can stake on behalf of another.
- [ ] A test confirms staking, executing tasks, and withdrawing rewards are independent operations that do not interfere with each other's balances.
- [ ] An event is emitted on deposit, following the existing (verb, noun) topic pattern.

## Files

- contracts/keeper-registry/src/staking.rs
- contracts/keeper-registry/src/test/staking.rs
