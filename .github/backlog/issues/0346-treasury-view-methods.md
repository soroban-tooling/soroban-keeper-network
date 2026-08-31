---
title: "feat(treasury): read-only views for current recipients, shares, and distribution history"
labels: [contract, enhancement, good-first-issue]
epic: E08
wave: 4
depends_on: [0340, 0342]
---

## Summary

Exposes the treasury's current configuration and running totals as read-only views, so a dashboard or an SDK consumer does not need to reconstruct the current state from event history alone.

## Acceptance criteria

- [ ] Views cover current recipient list with shares, total ever distributed, and total ever received.
- [ ] All are side-effect-free, following the registry's own views.rs policy.
- [ ] A test confirms each view's value after a sequence of configuration changes and distributions.

## Files

- contracts/treasury/src/lib.rs
