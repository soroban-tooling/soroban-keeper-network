---
title: "feat(registry): an appeal path for a keeper disputing its own slash"
labels: [contract, enhancement, advanced]
epic: E06
wave: 4
depends_on: [0291, 0293]
---

## Summary

If slashing (issue 0291) can be triggered by a single admin or a dispute process (issue 0293), a keeper wrongly slashed needs a documented recourse, not just an off-chain complaint. This issue decides and implements whether the contract itself supports an on-chain appeal, or whether recourse is explicitly off-chain (governance, in epic E09, once it exists) and this issue's deliverable is simply stating that clearly.

## Acceptance criteria

- [ ] The recourse mechanism (on-chain appeal, or an explicit statement that recourse is off-chain and where) is decided and documented.
- [ ] If an on-chain appeal exists, it cannot itself be used to indefinitely stall a legitimate slash, bounded by a configurable window.
- [ ] Tests cover a successful appeal reversing a slash and an appeal window expiring without one being raised.

## Files

- contracts/keeper-registry/src/staking.rs
- docs/STAKING_DESIGN.md
