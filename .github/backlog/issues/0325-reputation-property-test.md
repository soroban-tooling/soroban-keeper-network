---
title: "test(property): reputation updates are consistent with the recorded action history"
labels: [testing, contract, advanced]
epic: E07
wave: 4
depends_on: [0319, 0321]
---

## Summary

A property test confirming a keeper's stored reputation, at any point, is exactly what issue 0318's formula would produce from replaying that keeper's full recorded action history — the same replay-consistency check issue 0220 used for the indexer's derived task state, applied here to the contract's own on-chain derived score.

## Acceptance criteria

- [ ] The property generates a randomized sequence of successes and misses for one keeper and confirms the stored score matches an independent reference implementation of issue 0318's formula at every step.
- [ ] Decay (issue 0321) is included in the property, not tested separately in a way that could miss an interaction bug between decay and incremental updates.

## Files

- contracts/keeper-registry/src/test/property.rs
