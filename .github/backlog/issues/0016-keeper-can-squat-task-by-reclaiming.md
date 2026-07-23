---
title: "fix(registry): a keeper can hold a task indefinitely by re-claiming it every lock window"
labels: [contract, bug, advanced]
epic: E01
wave: 1
depends_on: []
---

## Summary

`claim_task` does not prevent the current claimer from claiming again. Each re-claim resets `claim_ledger`, restarting the lock window. A single keeper can therefore hold a task from registration to deadline without ever executing it, and no other keeper can take it.

## Current behaviour

```rust
match task.status {
    TaskStatus::Pending => {}
    TaskStatus::Claimed => {
        // Only allow a takeover once the current lock has expired.
        if !lock_expired(&e, &task) {
            return Err(KeeperError::LockPeriodActive);
        }
    }
    _ => return Err(KeeperError::InvalidTaskStatus),
}

task.status = TaskStatus::Claimed;
task.claimer = Some(keeper.clone());
task.claim_ledger = Some(e.ledger().sequence());
```

The guard checks only *whether* the lock has expired, never *who* is claiming. When it has expired, the existing claimer is as eligible as anyone else — and is strictly better positioned, because it knows exactly which ledger the window opens at.

## Why this defeats the stated design

The contract's own comment describes the property it intends to provide:

> This is what prevents a keeper from claiming and then never executing: after `lock_ledgers`, the task is fair game again.

And the README lists it as a shipped MVP feature:

> **Re-claim after lock expiry** — unresponsive keepers lose their lock

Neither holds. The lock does expire, but the incumbent can immediately re-take it. Winning that race is easy: the incumbent knows `claim_ledger + lock_ledgers` precisely, while a competitor must be polling and must land its transaction in the same ledger. The incumbent also has no reason to stop — re-claiming costs only a transaction fee.

## Why anyone would do this

The clearest case is a keeper suppressing a task it does not want executed. A liquidation task is a claim on value that some party would rather not lose; whoever benefits from the liquidation *not* happening can pay a stream of small transaction fees to guarantee it does not, while the task's owner watches a task that appears healthily claimed the entire time. When the deadline finally passes, the owner gets a refund and no liquidation — which for a lending protocol means bad debt.

There is a milder version too: a keeper parking profitable tasks to execute later at its convenience, blocking competitors in the meantime.

## Expected behaviour

Holding a task requires making progress. A keeper that has claimed and not executed cannot indefinitely exclude others.

## Suggested approach

This needs design discussion before code — please comment on the issue with your approach first. Some options, none obviously correct:

**Block immediate self-re-claim.** Reject `claim_task` when `task.claimer == Some(keeper)` and the task is already `Claimed`. Simplest, and it makes the exclusion cost a second address — which is trivial to obtain, so this is a speed bump rather than a fix.

**Cap total claims per task.** Store a claim counter; once it exceeds a bound the task can only be executed or expired. Bounded and simple to reason about, at the cost of one more field in `Task`.

**Cooldown after a lapsed claim.** Record that an address let a lock lapse and exclude it from re-claiming that task for N ledgers, giving competitors a clear window. More storage, but it targets the actual behaviour.

**Make it expensive.** Require a stake to claim and slash it when a claim lapses without execution. This is the economically sound answer and it is exactly what the Phase 2 staking work is for — which means this issue may be better resolved as "documented limitation, fixed by staking" than as a standalone patch.

A perfectly acceptable outcome for this issue is a PR that adds the cheap guard *and* documents the residual weakness in the README's "Known Design Decisions", rather than an elaborate mechanism that staking will replace.

## Acceptance criteria

- [ ] The chosen approach is agreed on the issue before implementation.
- [ ] A test demonstrates the original attack — claim, let the lock lapse, re-claim, repeat past several windows — and asserts it no longer succeeds unboundedly.
- [ ] A test asserts a legitimate takeover by a *different* keeper after lock expiry still works, so the fix does not break `test_reclaim_after_lock_window_elapses`.
- [ ] Any residual limitation is documented in the README's "Known Design Decisions".
- [ ] If a new `Task` field is added, the storage-layout implications for existing deployments are described in the PR.

## Files

- `contracts/keeper-registry/src/lib.rs` — `claim_task`, `lock_expired`, possibly `Task`
- `contracts/keeper-registry/src/test.rs`
- `README.md`
