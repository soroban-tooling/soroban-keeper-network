---
title: "feat(registry): an optional reputation floor for claim eligibility"
labels: [contract, enhancement, intermediate]
epic: E07
wave: 4
depends_on: [0318, 0319]
---

## Summary

Distinct from priority ordering (issue 0322's harder problem), a simple eligibility floor — a keeper below a configurable reputation threshold cannot claim at all — is straightforward to enforce on-chain, since it is a check against the claiming keeper alone, not a comparison against other keepers' concurrent intentions.

## Expected behaviour

If issue 0318's design calls for this, claim_task rejects a keeper below the configured floor with a dedicated typed error, mirroring how the staking minimum (epic E06 issue 0292) would gate claiming if that epic's design calls for a minimum stake.

## Acceptance criteria

- [ ] The floor, if enabled, is enforced in claim_task with a specific error distinguishable from other claim rejections.
- [ ] The floor is configurable by the admin and defaults to disabled (zero) so existing keepers are not retroactively locked out the moment this feature ships.
- [ ] A test covers a keeper exactly at the floor and one point below and above it.

## Files

- contracts/keeper-registry/src/task.rs
- contracts/keeper-registry/src/test/reputation.rs
