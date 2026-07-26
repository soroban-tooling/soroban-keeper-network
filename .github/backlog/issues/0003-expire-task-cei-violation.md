---
title: "fix(registry): expire_task transfers the refund before writing status, breaking checks-effects-interactions"
labels: [contract, security, bug, intermediate]
epic: E01
wave: 1
depends_on: []
---

## Summary

`expire_task` refunds the task owner before marking the task `Expired`, the same ordering problem as `cancel_task` but on a function that **anyone** can call.

## Current behaviour

```rust
// contracts/keeper-registry/src/lib.rs — expire_task
reward_token(&e).transfer(&e.current_contract_address(), &task.owner, &task.reward);
task.status = TaskStatus::Expired;
save_task(&e, task_id, &task);
```

At the moment `transfer` executes, storage still holds status `Pending` or `Claimed`, both of which pass the guard at the top of the function.

## Why this is the more serious of the two

`cancel_task` requires `owner.require_auth()`. `expire_task` requires no auth at all — it is permissionless by design, so that a stuck task can always be unwound. That is the right design, but it means the re-entrancy path does not require the attacker to control the task owner. Any address can call `expire_task` on any past-deadline task, and if the configured reward token re-enters during `transfer`, the refund is paid repeatedly out of the contract's pooled balance — which is escrow belonging to other tasks and rewards owed to keepers.

The permissionlessness that makes `expire_task` good for liveness is exactly what makes the ordering bug worth fixing.

## Expected behaviour

Status is written to storage before the transfer. A re-entrant `expire_task` for the same `task_id` is rejected with `InvalidTaskStatus`.

## Suggested approach

```rust
let refund = task.reward;
let owner = task.owner.clone();

// Effects before interaction.
task.status = TaskStatus::Expired;
save_task(&e, task_id, &task);

reward_token(&e).transfer(&e.current_contract_address(), &owner, &refund);
```

## Acceptance criteria

- [ ] `expire_task` writes status and calls `save_task` before the transfer.
- [ ] A regression test with a re-entrant mock token asserts the second call fails with `InvalidTaskStatus` and exactly one refund is paid.
- [ ] A test asserts that expiring a `Claimed` task still refunds the **owner**, not the claimer — this is existing behaviour and the fix must not change it.
- [ ] Contract token balance is conserved across the test.

## Files

- `contracts/keeper-registry/src/lib.rs` — `expire_task`
- `contracts/keeper-registry/src/test.rs`

## References

- Companion issue: the same ordering problem in `cancel_task`. The two fixes are independent and can land in separate PRs, but a single PR fixing both is also fine — say so in the description and link both issues.
