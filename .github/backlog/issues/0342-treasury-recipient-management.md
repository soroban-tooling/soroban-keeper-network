---
title: "feat(treasury): admin entry points to add, remove, and reweight recipients"
labels: [contract, enhancement, intermediate]
epic: E08
wave: 4
depends_on: [0340]
---

## Summary

Recipients and their shares from issue 0340 need to be configurable after initial deployment — a new stakeholder is added, an existing one's share changes, or a recipient is retired — without redeploying the treasury contract.

## Acceptance criteria

- [ ] Admin-gated entry points to add a recipient, remove one, and update shares, each re-validating that shares still sum correctly after the change.
- [ ] A pending distribution (funds already received but not yet distributed, if issue 0338's automation model allows that state to exist) is not silently lost or misrouted by a mid-flight configuration change; document and test the exact behavior.
- [ ] Events fire on every configuration change, following the project's established event-for-every-state-change convention.

## Files

- contracts/treasury/src/lib.rs
- contracts/treasury/src/test.rs
