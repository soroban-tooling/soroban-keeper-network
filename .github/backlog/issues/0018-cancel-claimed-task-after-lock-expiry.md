---
title: "feat(registry): let the owner cancel a Claimed task whose lock has lapsed"
labels: [contract, enhancement, intermediate]
epic: E01
wave: 1
depends_on: []
---

## Summary

`cancel_task` accepts only `Pending` tasks. Once any keeper claims a task, the owner cannot recover the escrow until the deadline passes, even if the claimer has demonstrably abandoned it.

## Current behaviour

```rust
if task.status != TaskStatus::Pending {
    return Err(KeeperError::InvalidTaskStatus);
}
```

The reasoning is documented and sound as far as it goes:

> Only Pending tasks can be cancelled — once a keeper has claimed one, the owner must wait for execution or for the deadline to pass (expire_task), so a keeper that has started work can't have the reward pulled out from under it.

Protecting a working keeper from having the bounty yanked mid-execution is correct. The problem is that the protection does not end when the work demonstrably stops.

## The gap

The contract already has a precise notion of "this keeper is no longer working on it": `lock_expired`. When the lock window elapses without an `execute_task`, the contract itself concludes the claim is stale — that is the entire basis on which it lets a *different keeper* take the task over.

So after lock expiry the contract simultaneously holds two positions:

- A competing keeper may take this task, because the claimer is presumed unresponsive.
- The owner may not cancel it, because the claimer is presumed to be working.

Both cannot be right. The practical consequence: an owner whose task was claimed one minute after registration and then abandoned must wait out the entire deadline — potentially days — with the reward escrowed, for work that will never happen. The owner's only lever is `extend_deadline`, which makes the wait longer.

This interacts badly with the re-claim squatting issue. A keeper that re-claims every lock window keeps the task permanently in `Claimed`, which under current rules also keeps it permanently uncancellable.

## Expected behaviour

`cancel_task` succeeds on a `Claimed` task whose lock window has elapsed, refunding the owner. A task inside an active lock window remains uncancellable.

## Suggested approach

Reuse the existing helper so there is exactly one definition of a stale claim:

```rust
match task.status {
    TaskStatus::Pending => {}
    // A claim whose lock window has lapsed is already treated as abandoned —
    // another keeper could take the task at this point — so the owner may
    // withdraw it rather than wait out the deadline.
    TaskStatus::Claimed if lock_expired(&e, &task) => {}
    _ => return Err(KeeperError::InvalidTaskStatus),
}
```

Consider whether the refund should be reduced when cancelling a lapsed claim — there is an argument that a keeper which did partial work deserves something. Recommendation: no. The contract has no way to verify partial work, and introducing a partial payout creates an incentive to claim tasks in bulk and never execute. Note the reasoning in the PR rather than leaving it implicit.

Apply the CEI ordering fix from the companion issue if it has not already landed; if it has, follow the corrected pattern.

## Acceptance criteria

- [ ] `cancel_task` succeeds on a `Claimed` task after its lock window elapses, and refunds the full reward.
- [ ] `cancel_task` still fails with `InvalidTaskStatus` on a `Claimed` task inside an active lock window — `test_cancel_claimed_task_fails` must be updated, not deleted, to assert this narrower behaviour.
- [ ] `cancel_task` still fails on `Executed`, `Cancelled`, and `Expired` tasks.
- [ ] A test covers the boundary: cancel at exactly `claim_ledger + lock_ledgers`.
- [ ] The task lifecycle state machine in README and `docs/ARCHITECTURE.md` shows the new transition.
- [ ] The `cancel_task` doc comment explains the lock-expiry condition.

## Files

- `contracts/keeper-registry/src/lib.rs` — `cancel_task`
- `contracts/keeper-registry/src/test.rs`
- `README.md` — FR-4 and the lifecycle diagram
- `docs/ARCHITECTURE.md`
