---
title: "feat(registry): decide the pause policy for every new staking entry point"
labels: [contract, security, intermediate]
epic: E06
wave: 4
depends_on: [0288, 0289, 0290, 0291]
---

## Summary

The pause switch's documented policy (wave 1 issue 0029's pause matrix, and its doc comment in admin.rs) blocks anything that opens new exposure while keeping fund-recovery paths open. Every new staking entry point needs to be classified against this same rule rather than left ungated by omission — exactly the gap issue 0014 found and fixed for extend_deadline, which this epic should not repeat.

## Expected behaviour

stake_deposit is blocked while paused (it opens new exposure, matching register_task and claim_task's treatment). withdraw_stake, once any unbonding delay has elapsed, remains open (it only returns already-owned funds, matching cancel_task, expire_task, and withdraw_rewards). slash's pause interaction depends on issue 0288's authorization model; decide explicitly whether an admin should be able to slash while the contract is paused for an incident, or whether that specific action should also freeze.

## Acceptance criteria

- [ ] Every staking entry point's pause behavior is decided and documented in the pause doc comment's table, extending the one wave 1 issue 0014 required.
- [ ] The pause-policy-matrix test (wave 2 issue in test/admin.rs) is extended to cover the new entry points, not left to only test the original set.
- [ ] README FR-7 is updated to reflect the new gated and ungated entry points.

## Files

- contracts/keeper-registry/src/admin.rs
- contracts/keeper-registry/src/staking.rs
- contracts/keeper-registry/src/test/admin.rs
- README.md
