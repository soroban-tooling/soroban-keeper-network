---
title: "feat(governance): read-only views for proposal state and vote tallies"
labels: [contract, enhancement, good-first-issue]
epic: E09
wave: 4
depends_on: [0363, 0364, 0365, 0366]
---

## Summary

Exposes proposal details, current tallies, quorum/passing status, and timelock remaining as read-only views, so a dashboard or SDK consumer can render a proposal's full state without replaying events.

## Acceptance criteria

- [ ] Views cover proposal details, live tallies, and current lifecycle state (open, passed-queued, executed, failed).
- [ ] All are side-effect-free.
- [ ] A test confirms each view's value at every stage of a proposal's lifecycle.

## Files

- contracts/governance/src/lib.rs
