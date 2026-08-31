---
title: "chore(release): CHANGELOG entries and versioning for the token and governance contracts"
labels: [docs, contract, good-first-issue]
epic: E09
wave: 4
depends_on: [0361, 0362, 0368]
---

## Summary

Following the release-notes discipline from issues 0096, 0310, and 0355, records the initial release of the KPRS token and governance contracts, and documents the registry's admin migration (issue 0368) as the single most significant change in the registry's own history to date.

## Acceptance criteria

- [ ] Both new contracts have their own VERSION constants starting at 1.
- [ ] The registry's CHANGELOG entry for the admin migration states plainly that admin control has moved from a single key to the governance contract, and links to docs/GOVERNANCE_DESIGN.md for the full mechanism.
- [ ] Any new registry-side changes required to support the migration are documented.

## Files

- contracts/governance-token/src/lib.rs
- contracts/governance/src/lib.rs
- CHANGELOG.md
