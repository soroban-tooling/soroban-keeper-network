---
title: "feat(registry): a dispute window between execution and reward finality"
labels: [contract, enhancement, advanced]
epic: E06
wave: 4
depends_on: [0288, 0291]
---

## Summary

Implements whichever dispute mechanism issue 0288 specified, if slashing in this project's first version is dispute-based rather than automatically triggered by an on-chain verifier (which epic E04's unimplemented verifier work would otherwise provide).

## Expected behaviour

A window after execute_task during which a task's execution can be disputed (by the task owner, or whichever party issue 0288 names), during which the keeper's net reward is held rather than immediately withdrawable, resolving to either a normal payout if undisputed or into the slash entry point from issue 0291 if the dispute is upheld.

## Suggested approach

This changes withdraw_rewards's semantics for a recently executed task: a keeper's credited balance should distinguish finalized-and-withdrawable from pending-dispute-window, since the current credit_keeper path makes a balance withdrawable the instant it is credited. Get this interaction exactly right, since it is the highest-value target for a bug in this epic — a bug here could either let a disputed reward be withdrawn before resolution or lock a legitimate reward indefinitely.

## Acceptance criteria

- [ ] A reward is not withdrawable until its dispute window has elapsed without a dispute, or until a dispute is resolved in the keeper's favor.
- [ ] A test confirms withdraw_rewards correctly rejects an attempt during an active dispute window and succeeds once it closes.
- [ ] A test confirms a successfully disputed reward is routed to the slash path from issue 0291, not silently paid out anyway.

## Files

- contracts/keeper-registry/src/staking.rs
- contracts/keeper-registry/src/task.rs
- contracts/keeper-registry/src/test/staking.rs
