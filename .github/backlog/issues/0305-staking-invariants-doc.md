---
title: "docs(architecture): document the staking invariants"
labels: [docs, security, contract, intermediate]
epic: E06
wave: 4
depends_on: [0288, 0050]
---

## Summary

Issue 0050 established the pattern of numbering and precisely stating every money invariant the contract holds. Staking introduces new invariants (staked funds are never spendable as task escrow or keeper reward, a slash never exceeds a keeper's current stake, unbonding funds are not double-counted as both staked and withdrawable) that need the same treatment before this epic is considered complete.

## Acceptance criteria

- [ ] Each new invariant is stated precisely enough to be testable, following the exact shape (statement, why, enforced by, breaks if) issue 0050 established.
- [ ] Each is cross-referenced to the specific test that verifies it (issue 0294's extended solvency property, in particular).
- [ ] docs/ARCHITECTURE.md's invariant list is renumbered or extended consistently, not appended in a way that breaks the existing I-N references other issues and tests already cite.

## Files

- docs/ARCHITECTURE.md
