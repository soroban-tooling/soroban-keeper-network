---
title: "test(property): distribution never creates or destroys value"
labels: [testing, contract, advanced]
epic: E08
wave: 4
depends_on: [0340, 0344]
---

## Summary

A dedicated conservation property for the treasury, in the same spirit as the registry's I-1 solvency invariant (issue 0054): across any sequence of distributions and recipient reconfigurations, the treasury's token balance always equals whatever remains undistributed, and the sum of all distributions ever made plus current undistributed balance equals total funds ever received.

## Acceptance criteria

- [ ] The property generates randomized sequences of receipts, recipient changes, and distributions, and confirms conservation holds after every step.
- [ ] A recipient-share reweighting mid-sequence does not retroactively alter the correctness of already-completed distributions.

## Files

- contracts/treasury/src/test.rs
