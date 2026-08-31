---
title: "feat(registry): a read-only view of the current minimum stake requirement"
labels: [contract, enhancement, good-first-issue]
epic: E06
wave: 4
depends_on: [0292]
---

## Summary

If issue 0292 established a minimum stake requirement, keeper bots and dashboards need to read its current value the same way min_reward already exposes the analogous task-side floor, rather than needing to attempt a claim and infer the requirement from a rejection.

## Acceptance criteria

- [ ] A min_stake view exists, mirroring min_reward's existing shape and defaults-to-zero-if-unset behavior.
- [ ] A test confirms the view reflects an admin update to the configured minimum.

## Files

- contracts/keeper-registry/src/staking.rs
