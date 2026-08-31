---
title: "feat(registry): decide how a slash (epic E06) affects reputation"
labels: [contract, enhancement, intermediate]
epic: E07
wave: 4
depends_on: [0318, 0291]
---

## Summary

If epic E06's staking work lands, a slash is a strong signal about a keeper's trustworthiness that reputation should plausibly reflect. This issue decides and implements that interaction explicitly, rather than leaving the two systems silently unaware of each other.

## Acceptance criteria

- [ ] The interaction (a slash reduces reputation by a defined amount, resets it, or is explicitly decided to have no effect) is documented and implemented.
- [ ] If epic E06 has not landed yet when this issue is picked up, it is deferred with the dependency stated explicitly, not implemented against a speculative slash interface.
- [ ] A test covers a keeper with strong prior reputation being slashed and confirms the resulting score matches the documented rule.

## Files

- contracts/keeper-registry/src/reputation.rs
- contracts/keeper-registry/src/staking.rs
