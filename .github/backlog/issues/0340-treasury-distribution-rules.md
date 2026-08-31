---
title: "feat(treasury): implement configurable distribution splits"
labels: [contract, enhancement, intermediate]
epic: E08
wave: 4
depends_on: [0338, 0339]
---

## Summary

Implements the actual splitting rule issue 0338 designed: dividing swept fees across the named recipients according to the configured percentages.

## Expected behaviour

A distribute(amount) entry point (called by the registry's sweep, or by an admin, per issue 0338's automation decision) that splits amount across configured recipients according to their configured basis-point shares, using the same checked-arithmetic discipline (no floating point, explicit rounding-direction documentation) split_reward already established for the registry's own keeper/fee split.

## Acceptance criteria

- [ ] Splits sum to exactly the input amount with no dust silently lost or created; document explicitly which recipient absorbs any rounding remainder, mirroring the documented floor-rounds-to-keeper behavior in split_reward.
- [ ] Configured shares must sum to 10,000 basis points (or whatever total issue 0338 specifies); a misconfigured set is rejected at configuration time, not silently normalized.
- [ ] A test distributes a range of amounts across a range of share configurations and confirms exact conservation.

## Files

- contracts/treasury/src/lib.rs
- contracts/treasury/src/test.rs
