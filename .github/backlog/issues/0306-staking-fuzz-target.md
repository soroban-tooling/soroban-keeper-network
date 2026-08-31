---
title: "test(fuzz): fuzz the staking entry points' arithmetic"
labels: [testing, contract, intermediate]
epic: E06
wave: 4
depends_on: [0289, 0290, 0291, 0051]
---

## Summary

Following the fuzzing infrastructure epic E03 established (issue 0051's harness, issue 0062's split_reward target), the new staking arithmetic (partial unbonds, partial slashes against a stake that may already be partially unbonding) is exactly the kind of boundary-heavy logic that benefits from fuzzing rather than only hand-written boundary tests.

## Acceptance criteria

- [ ] A fuzz target exercises deposit, unbond, and slash amounts across the full i128 range, confirming no panic and every rejection is a typed KeeperError.
- [ ] The target specifically covers the interaction of a partial unbond followed by a slash request larger than the remaining non-unbonding stake.
- [ ] Any crash found is fixed and its minimized input committed as a regression test, per the process issue 0069 established.

## Files

- fuzz/fuzz_targets/staking.rs
