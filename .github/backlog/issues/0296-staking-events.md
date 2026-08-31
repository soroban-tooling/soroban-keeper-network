---
title: "feat(registry): events for every staking state transition"
labels: [contract, enhancement, good-first-issue]
epic: E06
wave: 4
depends_on: [0289, 0290, 0291]
---

## Summary

Following the project's established convention that every state-relevant fact is emitted, not just logged, this issue audits the staking entry points from issues 0289 through 0291 and fills any gap: StakeDeposited, UnbondInitiated, StakeWithdrawn, and Slashed.

## Acceptance criteria

- [ ] Each of the four events exists with the two-symbol topic pattern the rest of events.rs uses.
- [ ] Each carries enough payload to reconstruct the action without a follow-up on-chain query (amounts, the keeper address, and for Slashed, the reason).
- [ ] The README event table is updated to include all four, matching the sync discipline wave 1 issue 0017 established.

## Files

- contracts/keeper-registry/src/events.rs
- README.md
