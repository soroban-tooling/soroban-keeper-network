---
title: "test(fuzz): fuzz the reputation update and decay arithmetic"
labels: [testing, contract, intermediate]
epic: E07
wave: 4
depends_on: [0319, 0321, 0051]
---

## Summary

Following the same reasoning as staking's fuzz target (issue 0306), the reputation update and decay arithmetic is boundary-heavy logic worth fuzzing across the full plausible input range rather than only hand-picked boundary tests.

## Acceptance criteria

- [ ] A fuzz target exercises update sequences and elapsed-ledger values across a wide range, confirming no panic and that the decay function never produces a nonsensical value (negative reputation, if the design specifies reputation is non-negative).
- [ ] Any crash found is fixed and committed as a regression test per issue 0069's process.

## Files

- fuzz/fuzz_targets/reputation.rs
