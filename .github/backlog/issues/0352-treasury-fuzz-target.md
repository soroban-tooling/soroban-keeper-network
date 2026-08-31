---
title: "test(fuzz): fuzz the distribution split arithmetic"
labels: [testing, contract, intermediate]
epic: E08
wave: 4
depends_on: [0340, 0051]
---

## Summary

Following the fuzzing discipline applied to the registry's own split_reward (issue 0062) and to staking (issue 0306), the treasury's distribution arithmetic across an arbitrary number of recipients with arbitrary share configurations is worth fuzzing directly.

## Acceptance criteria

- [ ] A fuzz target exercises distribution amounts and recipient-share configurations across the full plausible range, confirming exact conservation (sum of distributed amounts equals input amount) and no panic.
- [ ] The target specifically covers the maximum configured number of recipients, to catch any per-recipient rounding accumulation issue that would not show up with only two or three recipients.
- [ ] Any crash found is fixed and committed as a regression test.

## Files

- fuzz/fuzz_targets/treasury_distribution.rs
