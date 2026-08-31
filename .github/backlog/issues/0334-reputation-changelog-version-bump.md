---
title: "chore(release): CHANGELOG entry and VERSION bump for reputation"
labels: [docs, contract, good-first-issue]
epic: E07
wave: 4
depends_on: [0319, 0320, 0324]
---

## Summary

Following the pattern from issue 0310's staking release notes, bumps VERSION and records every user-visible change from this epic once the core reputation tracking, view, and events are complete.

## Acceptance criteria

- [ ] VERSION is bumped and test_version_is_exposed is updated.
- [ ] CHANGELOG entry covers the new view, event, and any new KeeperError variant (the eligibility-floor rejection, if enabled).
- [ ] States plainly whether this is additive-only or changes any existing entry point's observable behavior (claim_task's rejection conditions, if the floor is enabled).

## Files

- contracts/keeper-registry/src/constants.rs
- contracts/keeper-registry/src/test/reward_split.rs
- CHANGELOG.md
