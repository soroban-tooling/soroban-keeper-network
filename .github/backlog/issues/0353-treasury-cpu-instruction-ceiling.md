---
title: "test(registry): CPU-instruction regression ceiling for distribute"
labels: [testing, contract, good-first-issue]
epic: E08
wave: 4
depends_on: [0340]
---

## Summary

Following the pattern established in issue 0107 and extended to staking in issue 0303, this issue measures and pins a CPU-instruction ceiling for the treasury's distribute function, which is more sensitive than most entry points to a configuration change (more recipients means more per-call work) and therefore worth a specific regression guard.

## Acceptance criteria

- [ ] A baseline is measured at the maximum configured recipient count.
- [ ] A ceiling is set at a documented multiple of the baseline.
- [ ] The test fails loudly if a future change pushes distribute's cost past the ceiling at the same recipient count.

## Files

- contracts/treasury/src/test.rs
