---
title: "feat(registry): decide and enforce a minimum stake to claim tasks"
labels: [contract, enhancement, intermediate]
epic: E06
wave: 4
depends_on: [0288, 0289]
---

## Summary

A staking system with no consequence for claiming without any stake at all does not change keeper behavior. This issue decides, per issue 0288's scope, whether claim_task should require a minimum stake at all, and if so, implements the check.

## Expected behaviour

If a minimum is required: claim_task rejects a keeper whose current stake is below a configurable floor, mirroring the min_reward_floor pattern already used for task registration. If issue 0288 decided staking is opt-in with no claiming requirement in a first version, this issue instead documents that decision on claim_task's own doc comment so a future contributor does not assume the requirement exists.

## Acceptance criteria

- [ ] The decision (required minimum, or explicitly opt-in) is reflected correctly in claim_task's actual behavior.
- [ ] If a minimum is enforced, it is configurable by the admin, matching the pattern set_min_reward already establishes for the analogous task-side floor.
- [ ] A test covers a keeper exactly at the floor, one ledger of unbonding below it, and one action above it.

## Files

- contracts/keeper-registry/src/task.rs
- contracts/keeper-registry/src/test/staking.rs
