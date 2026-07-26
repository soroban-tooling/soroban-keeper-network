---
title: "test(registry): assert expire_task on a Claimed task refunds the owner, not the claimer"
labels: [testing, contract, good-first-issue]
epic: E02
wave: 1
depends_on: []
---

## Summary

`expire_task` accepts both `Pending` and `Claimed` tasks and always refunds `task.owner`. The `Claimed` case is untested, and it is the case where the payout destination is a real decision rather than an obvious one.

## Current coverage

- `test_expire_after_deadline_refunds_owner` — expires a `Pending` task.
- `test_expire_before_deadline_fails` — deadline guard.
- `test_expire_executed_task_fails` — terminal state guard.

Nothing expires a task that a keeper had claimed.

## Why the Claimed case deserves its own test

The guard admits it:

```rust
match task.status {
    TaskStatus::Pending | TaskStatus::Claimed => {}
    _ => return Err(KeeperError::InvalidTaskStatus),
}
```

and the refund is unconditional:

```rust
reward_token(&e).transfer(&e.current_contract_address(), &task.owner, &task.reward);
```

So a keeper can claim a task, do the off-chain work, fail to land its `execute_task` before the deadline, and watch the entire reward go back to the owner. That is a defensible policy — the contract cannot verify off-chain work, and paying for unproven execution would be worse — but it is a policy, and it is currently enforced by code that no test pins down.

It is also permissionless, so the *owner* can call `expire_task` the moment the deadline passes to reclaim a bounty from a keeper that was one ledger too slow. Worth knowing that is the behaviour.

If someone later "fixed" this to pay the claimer, or split the reward, no test would object.

## Expected behaviour

A test proves that expiring a claimed task pays the owner in full and pays the claimer nothing.

## Suggested approach

```
1. Register a task with a known reward.
2. Have a keeper claim it.
3. Advance the ledger timestamp past the deadline.
4. Record owner and keeper token balances.
5. Call expire_task from a third, unrelated address.
6. Assert:
   - owner balance increased by exactly the full reward
   - keeper token balance is unchanged
   - keeper_balance(keeper) is still zero — no credit was recorded
   - fees_accrued did not change — expiry takes no fee
   - task status is Expired
   - the TaskExpired event was emitted
```

Calling from a third address matters: it confirms the function is genuinely permissionless and that the caller receives nothing for triggering it.

Add a second test asserting the task cannot then be executed, so the claimer cannot land a late `execute_task` against an expired task and get paid twice over.

Assert `fees_accrued` explicitly. A refund path taking a protocol fee would be a real bug — the owner would silently receive less than they escrowed — and nothing currently rules it out.

## Acceptance criteria

- [ ] A test expires a `Claimed` task and asserts the owner receives the full reward.
- [ ] The same test asserts the claimer receives nothing, in both token balance and credited balance.
- [ ] The test asserts `fees_accrued` is unchanged by expiry.
- [ ] `expire_task` is called from an address that is neither the owner nor the claimer.
- [ ] A follow-up assertion confirms `execute_task` on the now-expired task fails.
- [ ] The behaviour is documented on `expire_task`'s doc comment if it is not already clear.

## Files

- `contracts/keeper-registry/src/test.rs`
- `contracts/keeper-registry/src/lib.rs` — doc comment only

## Getting started

Good first issue. `test_expire_after_deadline_refunds_owner` is the template; the only change is claiming the task before advancing time.
