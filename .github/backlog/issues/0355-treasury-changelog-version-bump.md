---
title: "chore(release): CHANGELOG entry and versioning for the treasury contract"
labels: [docs, contract, good-first-issue]
epic: E08
wave: 4
depends_on: [0339, 0340]
---

## Summary

Following the release-notes discipline established in issues 0096 and 0310, records the treasury contract's initial release, and if issue 0341 changed the registry's sweep_fees behavior, bumps the registry's VERSION and documents that change too.

## Acceptance criteria

- [ ] The treasury contract has its own VERSION constant, following the registry's convention, starting at 1.
- [ ] If sweep_fees's behavior changed, the registry's VERSION is bumped and CHANGELOG documents the change plainly.
- [ ] Any new registry-side KeeperError variant (if the sweep integration required one) is documented.

## Files

- contracts/treasury/src/lib.rs
- CHANGELOG.md
