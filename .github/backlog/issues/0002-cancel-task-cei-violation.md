---
title: "fix(registry): cancel_task transfers the refund before writing status, breaking checks-effects-interactions"
labels: [contract, security, bug, intermediate]
epic: E01
wave: 1
depends_on: []
---

## Summary

`cancel_task` transfers the escrowed reward to the owner **before** it sets `task.status = Cancelled`. Every other fund-moving path in this contract writes state first. This one does not, and the inline comment acknowledges the ordering without fully justifying it.

## Current behaviour

```rust
// contracts/keeper-registry/src/lib.rs — cancel_task
// Refund the escrow, then mark cancelled (CEI: state after transfer is
// safe here because status guards prevent re-entry into a fresh cancel).
reward_token(&e).transfer(&e.current_contract_address(), &owner, &task.reward);
task.status = TaskStatus::Cancelled;
save_task(&e, task_id, &task);
```

The comment's reasoning is circular: the guard checks `task.status`, and at the moment `transfer` is called the task is **still `Pending`** in storage. The write that would make the guard effective has not happened yet.

## Why this matters

`reward_token` is not a fixed contract. It is whatever address was passed to `initialize` as `reward_token`, and the registry calls into it. If that token is ever a non-standard or malicious SAC-like contract, its `transfer` can call back into `cancel_task` for the same `task_id`. On re-entry:

- `load_task` reads status `Pending` — the guard passes.
- The escrow is transferred a second time.

Repeat until the contract's token balance is drained, at which point the loss falls on *other* tasks' escrow and on keeper balances, not just on the caller.

Today the reward token is expected to be the native XLM SAC, which does not re-enter. This is a defence-in-depth fix: the contract's own security section states "State transitions happen before token transfers (CEI pattern throughout)", and this function is an exception to a property the project claims to hold. An invariant with an exception is not an invariant.

## Expected behaviour

The status write and `save_task` happen before the token transfer, so a re-entrant call sees `Cancelled` and is rejected with `InvalidTaskStatus`.

## Suggested approach

```rust
// Effects before interaction: a re-entrant cancel must find the task already
// Cancelled and be rejected by the status guard above.
let refund = task.reward;
task.status = TaskStatus::Cancelled;
save_task(&e, task_id, &task);
reward_token(&e).transfer(&e.current_contract_address(), &owner, &refund);
```

Note that `task.reward` is read after the move into storage, so keep a local copy of the amount before `save_task`.

Delete the misleading comment and replace it with one that states the actual invariant.

## Acceptance criteria

- [ ] `cancel_task` writes status and calls `save_task` before any token transfer.
- [ ] A regression test uses a mock reward token that attempts to re-enter `cancel_task` during `transfer`, and asserts the re-entrant call fails with `InvalidTaskStatus` and that exactly one refund was paid.
- [ ] The comment explaining the ordering is accurate.
- [ ] The contract's token balance after the test equals its balance before the cancel, minus exactly one reward.

## Files

- `contracts/keeper-registry/src/lib.rs` — `cancel_task`
- `contracts/keeper-registry/src/test.rs`

## References

- README, "Security Properties", which asserts CEI holds throughout.
- Companion issue: the same ordering problem in `expire_task`.
