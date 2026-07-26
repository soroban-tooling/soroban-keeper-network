---
title: "fix(registry): a task whose storage TTL expires before its deadline permanently strands the escrow"
labels: [contract, security, bug, advanced]
epic: E01
wave: 1
depends_on: []
---

## Summary

`register_task` accepts `ttl_ledgers` and `deadline` as independent parameters and never checks them against each other. If the storage entry's TTL elapses before the deadline does, the `Task` record is evicted from persistent storage while the escrowed reward is still sitting in the contract. Every function that could return that money — `cancel_task`, `expire_task`, `execute_task` — starts with `load_task`, which now returns `TaskNotFound`. The funds are unrecoverable by anyone, including the admin.

## How it happens

```rust
// register_task — no relationship is enforced between these two
if deadline <= e.ledger().timestamp() {
    return Err(KeeperError::DeadlinePassed);
}
reward_token(&e).transfer(&owner, &e.current_contract_address(), &reward);
```

```rust
// save_task — TTL comes straight from the caller
fn save_task(e: &Env, task_id: u64, task: &Task) {
    e.storage().persistent().set(&DataKey::Task(task_id), task);
    e.storage().persistent().extend_ttl(
        &DataKey::Task(task_id),
        task.ttl_ledgers,
        task.ttl_ledgers,
    );
}
```

`deadline` is a **unix timestamp in seconds**. `ttl_ledgers` is a **count of ledgers**. Stellar closes a ledger roughly every 5 seconds, so the two are in different units and there is no way for a caller to get the relationship right by accident.

Concrete example. A caller registers a task with a 30-day deadline (`deadline = now + 2_592_000`) and copies `ttl_ledgers = 17_280` from the integration example in the README, which is described there as "~1 day":

- The task becomes expirable 30 days from now.
- Its storage entry dies in roughly 1 day.
- On day 2, `expire_task` returns `TaskNotFound`.
- The reward is gone.

The README's own integration snippet pairs `deadline: now + 3600` with `ttl_ledgers: 17_280`, which is safe. But nothing stops the deadline being increased without the TTL following, and `extend_deadline` makes this trivially reachable: it pushes `deadline` arbitrarily far out and never touches `ttl_ledgers`.

## Expected behaviour

It is impossible to create or mutate a task whose storage entry can expire while its escrow is still held. Either the contract rejects the combination, or it derives the TTL so the invariant holds by construction.

## Suggested approach

Discuss the approach on this issue before implementing — this is a design decision, not a mechanical fix. Two viable directions:

**A. Validate at the boundary.** Convert the deadline into a ledger count and require the TTL to cover it with a safety margin:

```rust
/// Ledgers close roughly every 5 seconds on Stellar. Used only to sanity-check
/// that a task's storage outlives its deadline; a conservative estimate is
/// correct here because over-estimating the ledger rate over-provisions TTL.
const SECONDS_PER_LEDGER: u64 = 5;
/// Extra ledgers kept beyond the deadline so `expire_task` is still callable
/// after the deadline passes.
const TTL_SAFETY_MARGIN_LEDGERS: u32 = 17_280; // ~1 day
```

Reject with a new `TtlTooShort` error when the TTL does not cover `(deadline - now) / SECONDS_PER_LEDGER + TTL_SAFETY_MARGIN_LEDGERS`. Apply the same check in `extend_deadline`.

**B. Derive the TTL and drop the parameter.** Remove `ttl_ledgers` from the ABI entirely and compute it from the deadline. This is the more robust option — an invariant that cannot be expressed as a parameter cannot be violated by a caller — but it is a breaking ABI change and needs a version bump.

Either way, also consider having `save_task` re-extend the TTL on every mutation so an active task's storage lifetime keeps moving forward.

## Acceptance criteria

- [ ] A task cannot be registered with a TTL that expires before its deadline plus the safety margin.
- [ ] `extend_deadline` cannot push a deadline past the entry's TTL coverage.
- [ ] A test registers a task with a long deadline and a short TTL and asserts it is rejected, naming the specific error.
- [ ] A test advances the ledger past the old TTL boundary on a valid task and asserts `expire_task` still succeeds and refunds the owner.
- [ ] The unit mismatch between `deadline` (seconds) and `ttl_ledgers` (ledgers) is documented on both parameters.
- [ ] `docs/ARCHITECTURE.md` describes the invariant.
- [ ] If the ABI changes, `VERSION` is bumped and the change is noted in `CHANGELOG.md`.

## Files

- `contracts/keeper-registry/src/lib.rs` — `register_task`, `extend_deadline`, `save_task`
- `contracts/keeper-registry/src/test.rs`
- `docs/ARCHITECTURE.md`
- `README.md` — the integration snippet and storage table

## References

- [Soroban state archival](https://developers.stellar.org/docs/build/guides/archival) — how persistent entry TTL and eviction actually work.
