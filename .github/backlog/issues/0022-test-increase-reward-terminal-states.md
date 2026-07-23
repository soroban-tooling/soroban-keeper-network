---
title: "test(registry): cover increase_reward and extend_deadline on claimed and terminal tasks"
labels: [testing, contract, good-first-issue]
epic: E02
wave: 1
depends_on: []
---

## Summary

`increase_reward` and `extend_deadline` both accept `Pending` and `Claimed` tasks and reject the three terminal states. Only a fraction of that matrix is tested.

## Current coverage

For `increase_reward`:

- `test_increase_reward_escrows_and_raises_bounty` — happy path on a Pending task.
- `test_increase_reward_by_non_owner_fails` — wrong caller.

For `extend_deadline`:

- `test_extend_deadline_pushes_it_out` — happy path on a Pending task.
- `test_extend_deadline_backwards_fails` — new deadline not later than the old one.

Untested for both: the `Claimed` case, and all three terminal states.

## The gap

Both functions contain this guard:

```rust
match task.status {
    TaskStatus::Pending | TaskStatus::Claimed => {}
    _ => return Err(KeeperError::InvalidTaskStatus),
}
```

Nothing verifies that `Claimed` is genuinely accepted, and nothing verifies that `Executed`, `Cancelled`, and `Expired` are genuinely rejected. If someone tightened the guard to `Pending` only, or loosened it to allow everything, the suite would stay green.

The `Claimed` case is the one that matters most in practice. Topping up the reward on a task a keeper has already claimed is a real scenario — the owner notices the bounty was too low to motivate execution and raises it mid-lock. It is also the case with the subtlest behaviour, because the keeper's payout is computed from `task.reward` at execute time, so a top-up after a claim *does* increase what that specific keeper earns.

Extending the deadline on a `Claimed` task has a similar wrinkle: it does not extend the *lock* window, so the claimer gets more time to execute but competitors also become eligible to take over at the original unlock ledger. That is worth pinning down with a test.

## Expected behaviour

Every status the guard accepts and every status it rejects has a test.

## Suggested approach

Add tests for `increase_reward`:

- Top up a `Claimed` task and assert `get_task().reward` reflects it.
- Top up a `Claimed` task, then execute, and assert the keeper is credited from the *increased* reward net of fee. This is the behaviourally interesting one.
- Reject on `Executed`, `Cancelled`, and `Expired`, asserting `InvalidTaskStatus`.
- Assert a rejected top-up transfers no tokens — check the owner's balance is unchanged.

And for `extend_deadline`:

- Extend a `Claimed` task and assert the new deadline.
- Assert the lock window is unaffected: a competing keeper can still take over at the original `claim_ledger + lock_ledgers`, not at a later ledger.
- Reject on all three terminal states.

The existing tests show the setup pattern. Several of these differ only in the status they set up, so a small helper that drives a task into a given status will keep the additions readable.

## Acceptance criteria

- [ ] `increase_reward` has a passing test for `Claimed`, and rejection tests for `Executed`, `Cancelled`, and `Expired`.
- [ ] A test asserts a top-up on a claimed task flows through to the keeper's credited amount on execute.
- [ ] A test asserts a rejected top-up moves no tokens.
- [ ] `extend_deadline` has the same status matrix covered.
- [ ] A test asserts extending the deadline does not extend the lock window.
- [ ] Repeated setup is factored into a helper rather than copy-pasted.

## Files

- `contracts/keeper-registry/src/test.rs`

## Getting started

Good first issue. No contract changes — pure test additions. Read `test_increase_reward_escrows_and_raises_bounty` for the setup pattern and `test_cancel_claimed_task_fails` for how to drive a task into `Claimed`.
