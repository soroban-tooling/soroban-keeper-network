---
title: "fix(governance): ensure proposal and vote storage is covered by TTL renewal"
labels: [contract, correctness, good-first-issue]
epic: E09
wave: 4
depends_on: [0363, 0364]
---

## Summary

Following the same discipline required of every other epic's new storage (issues 0312 for staking, 0332 for reputation), this confirms proposal and vote-record storage entries are correctly TTL-renewed on write, so a long-running vote or a queued timelock does not risk archival before it resolves.

## Acceptance criteria

- [ ] Every write to proposal or vote-record storage renews its TTL appropriately for the storage class used (instance or persistent, per issue 0362's scaffolding decision).
- [ ] A test advances the ledger across a full voting period plus timelock delay and confirms the proposal remains accessible and executable throughout, with no archival in between.

## Files

- contracts/governance/src/lib.rs
- contracts/governance/src/test.rs
