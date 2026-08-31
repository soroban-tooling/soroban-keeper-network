---
title: "test(property): extend the solvency invariant to cover stake escrow"
labels: [testing, contract, advanced]
epic: E06
wave: 4
depends_on: [0289, 0291, 0054]
---

## Summary

Issue 0054's solvency property (I-1: the registry's token balance equals open task escrow plus credited keeper balances plus accrued fees) needs a fourth term once stake exists: staked-and-not-slashed amounts. Without extending it, this epic's own escrow could silently break the invariant the rest of the contract depends on.

## Expected behaviour

The solvency check from contracts/keeper-registry/src/invariants.rs gains a stake term, and the property test from issue 0054 is extended to interleave staking, unbonding, and slashing actions with the existing task lifecycle actions, confirming the sum still holds across all of them.

## Acceptance criteria

- [ ] assert_solvent (or a new sibling function) accounts for total staked balance.
- [ ] The property test generates sequences mixing task actions and staking actions and confirms solvency holds after every step.
- [ ] A slash is confirmed to move value out of the sum correctly (to whatever destination issue 0291 specified), not simply vanish it from accounting while leaving it in the contract's actual balance, or vice versa.

## Files

- contracts/keeper-registry/src/invariants.rs
- contracts/keeper-registry/src/test/property.rs
