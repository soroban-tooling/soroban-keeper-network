---
title: "test(property): confirm condition checks never affect solvency"
labels: [testing, contract, advanced]
epic: E10
wave: 4
depends_on: [0393, 0054]
---

## Summary

Following the same extension pattern applied to staking (issue 0294), this extends the I-1 solvency property to cover tasks with an attached condition, confirming a rejected claim attempt never moves any token and the invariant holds across randomized sequences mixing conditioned and unconditioned tasks.

## Acceptance criteria

- [ ] The property test includes tasks with always-true, always-false, and state-changing conditions (a condition that starts false and later becomes true) in its generated scenarios.
- [ ] Solvency holds after every step regardless of condition outcome.
- [ ] A rejected claim attempt is confirmed to leave the task's escrow completely untouched, not merely unchanged in total sum by coincidence.

## Files

- contracts/keeper-registry/src/test/property.rs
