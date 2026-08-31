---
title: "feat(registry): the slash entry point and its authorization model"
labels: [contract, security, advanced]
epic: E06
wave: 4
depends_on: [0288, 0289]
---

## Summary

Implements the actual slashing mechanic: reducing a keeper's stake in response to whatever condition issue 0288 defined as slashable, gated by whatever authorization model (admin-triggered, dispute-resolution-triggered, or automatic from a verifier check) that same design settled on.

## Expected behaviour

A slash(keeper, amount, reason) entry point matching issue 0288's chosen trigger, moving the slashed amount to a treasury or burn destination (decide and document which, consistent with how sweep_fees already routes protocol fees to a treasury address), and emitting an event carrying the reason so the action is auditable after the fact.

## Acceptance criteria

- [ ] Slashing can only be triggered by the authorized party issue 0288's design specifies, verified by a test that confirms an unauthorized caller is rejected.
- [ ] A slash never removes more than the keeper's current stake, and cannot be applied twice for the same underlying incident without an explicit, intentional mechanism to do so.
- [ ] The slashed amount's destination matches the design document exactly.
- [ ] An event carries enough information (keeper, amount, reason) to reconstruct why a slash occurred from the indexer's event history alone.

## Files

- contracts/keeper-registry/src/staking.rs
- contracts/keeper-registry/src/test/staking.rs
