---
title: "feat(registry): read-only views for stake, unbonding status, and slash history"
labels: [contract, enhancement, good-first-issue]
epic: E06
wave: 4
depends_on: [0289, 0290, 0291]
---

## Summary

Adds the read-only surface a keeper bot or dashboard needs to reason about staking without parsing event history: current stake, amount currently unbonding and its release ledger, and a simple slash count or total-slashed figure.

## Acceptance criteria

- [ ] keeper_stake, unbonding_status, and a slash-history view (exact name and shape per issue 0288's design) are implemented.
- [ ] All are side-effect-free and never bump storage TTL, consistent with the existing views.rs policy.
- [ ] A test confirms each view's value updates correctly across a deposit, an unbond, and a slash.

## Files

- contracts/keeper-registry/src/staking.rs
