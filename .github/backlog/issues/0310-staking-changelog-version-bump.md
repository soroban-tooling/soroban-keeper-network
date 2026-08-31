---
title: "chore(release): CHANGELOG entry and VERSION bump for staking"
labels: [docs, contract, good-first-issue]
epic: E06
wave: 4
depends_on: [0289, 0290, 0291, 0296]
---

## Summary

Following the exact pattern issue 0096 established for closing out the verifier epic, this issue bumps the contract's VERSION constant and records every user-visible change from this epic in CHANGELOG.md once the core staking entry points, events, and views are complete.

## Acceptance criteria

- [ ] VERSION is bumped and test_version_is_exposed (or its current equivalent in test/reward_split.rs) is updated.
- [ ] CHANGELOG entry covers every new entry point, event, error variant, and view this epic introduced.
- [ ] Explicitly calls out this is an additive change (no existing entry point's signature changed), so integrators know a v2-family contract upgrade is not required just to keep existing functionality working.

## Files

- contracts/keeper-registry/src/constants.rs
- contracts/keeper-registry/src/test/reward_split.rs
- CHANGELOG.md
