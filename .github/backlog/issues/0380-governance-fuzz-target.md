---
title: "test(fuzz): fuzz proposal tallying and timelock arithmetic"
labels: [testing, contract, intermediate]
epic: E09
wave: 4
depends_on: [0364, 0366, 0051]
---

## Summary

Following the fuzzing discipline applied to every other epic's arithmetic-heavy logic (issues 0062, 0306, 0331, 0352), this fuzzes the vote-tallying and timelock-boundary computations, since a governance contract's correctness is unusually high-stakes given it can ultimately control the entire registry's admin functions.

## Acceptance criteria

- [ ] A fuzz target exercises voting-power sums and tally computations across the full plausible input range, confirming no panic and no arithmetic that silently overflows or wraps.
- [ ] Timelock boundary arithmetic is included, covering the same style of off-by-one risk as the registry's own lock_expired boundary testing.
- [ ] Any crash found is fixed and committed as a regression test.

## Files

- fuzz/fuzz_targets/governance.rs
