---
title: "test(registry): pin down the lock-expiry boundary ledger exactly"
labels: [testing, contract, intermediate]
epic: E02
wave: 1
depends_on: []
---

## Summary

`lock_expired` compares against `claim_ledger + lock_ledgers` with a `>=`. The tests that exercise re-claiming advance the ledger well past that point, so the exact boundary — and therefore whether the comparison is inclusive — is untested.

## Current behaviour

```rust
fn lock_expired(e: &Env, task: &Task) -> bool {
    match task.claim_ledger {
        Some(claimed_at) => {
            let unlock_at = claimed_at.saturating_add(task.lock_ledgers);
            e.ledger().sequence() >= unlock_at
        }
        None => true,
    }
}
```

`test_claim_locked_task_by_second_keeper_fails` tests well inside the window; `test_reclaim_after_lock_window_elapses` tests well outside it. Neither lands on `unlock_at` itself. Changing `>=` to `>` would keep both green while shifting the boundary by one ledger.

One ledger is roughly five seconds. That is not a large window, but it is the exact moment two keepers are racing for the same task, and it is the difference between a takeover transaction succeeding and being rejected with `LockPeriodActive`. A keeper implementation that computes the unlock ledger from `get_task` needs the boundary to be a specification, not an accident.

## The `None` branch is also untested

`lock_expired` returns `true` when `claim_ledger` is `None`. That branch is reachable through `is_claimable` on a `Pending` task — but `is_claimable` matches `Pending` before it ever consults `lock_expired`, so in practice the branch is only reached if a task is somehow `Claimed` with no `claim_ledger`. That combination should be impossible, since `claim_task` always sets both together.

Worth confirming rather than assuming. If it genuinely is unreachable, the branch deserves a comment saying so, per the project's own rule about documenting unreachable states.

## Expected behaviour

Tests assert behaviour at exactly `unlock_at - 1`, `unlock_at`, and `unlock_at + 1`, so the boundary is fixed by the suite.

## Suggested approach

Use a small `lock_ledgers` — say 10 — so the arithmetic is easy to follow, and drive the ledger sequence precisely:

```
1. Register a task and claim it as keeper A. Record claim_ledger.
2. Set ledger sequence to claim_ledger + lock_ledgers - 1.
   Assert: keeper B's claim fails with LockPeriodActive.
   Assert: is_claimable returns false.
3. Set ledger sequence to claim_ledger + lock_ledgers.
   Assert: keeper B's claim succeeds.
   Assert: is_claimable returned true before that claim.
4. Assert the task's claimer is now B and claim_ledger was reset.
```

Assert `is_claimable` alongside `claim_task` at each point. They are two independent readings of the same condition, and a bot that pre-filters with `is_claimable` and then calls `claim_task` depends on them agreeing. Nothing currently tests that they do.

Add a test for the interaction with the deadline: a lock that would expire *after* the deadline. The task becomes unclaimable due to the deadline check before the lock ever lapses, so the takeover path is unreachable. Confirm that ordering.

## Acceptance criteria

- [ ] Tests assert claim behaviour at `unlock_at - 1`, `unlock_at`, and `unlock_at + 1`.
- [ ] `is_claimable` is asserted at the same three points and agrees with `claim_task`.
- [ ] A test covers a lock window extending past the deadline.
- [ ] The inclusive boundary is stated in `lock_expired`'s doc comment.
- [ ] The `claim_ledger == None` branch is either tested or annotated as unreachable with a comment explaining why.

## Files

- `contracts/keeper-registry/src/test.rs`
- `contracts/keeper-registry/src/lib.rs` — doc comment only
