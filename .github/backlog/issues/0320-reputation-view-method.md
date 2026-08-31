---
title: "feat(registry): a read-only reputation view"
labels: [contract, enhancement, good-first-issue]
epic: E07
wave: 4
depends_on: [0319]
---

## Summary

Exposes the reputation record from issue 0319 as a read-only view so a keeper bot or dashboard can query it without reconstructing it from event history.

## Acceptance criteria

- [ ] A keeper_reputation(keeper) view returns the exact stored record, side-effect-free and never bumping TTL, consistent with every other view.
- [ ] Returns a documented default (zero, or whatever issue 0318 specifies) for an address with no tracked history, rather than erroring.

## Files

- contracts/keeper-registry/src/reputation.rs
