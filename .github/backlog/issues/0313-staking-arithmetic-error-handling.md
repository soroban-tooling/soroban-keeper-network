---
title: "fix(registry): typed overflow errors for all staking arithmetic, no panicking expects"
labels: [contract, correctness, good-first-issue]
epic: E06
wave: 4
depends_on: [0289, 0290, 0291]
---

## Summary

Wave 1's issue 0009 replaced panicking .expect() calls in the original contract with typed KeeperError::ArithmeticOverflow results. Every arithmetic operation introduced by this epic's staking entry points (adding to a stake, subtracting a slash amount, comparing unbond amounts) needs the same discipline from the start.

## Acceptance criteria

- [ ] No staking arithmetic uses .expect() or unwrap() on a checked operation; every one returns ArithmeticOverflow on failure.
- [ ] A fuzz or property test (building on issue 0306) specifically targets this and confirms no panic is reachable through any combination of staking calls.

## Files

- contracts/keeper-registry/src/staking.rs
