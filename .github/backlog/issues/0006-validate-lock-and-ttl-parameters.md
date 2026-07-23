---
title: "feat(registry): validate lock_ledgers and ttl_ledgers at registration"
labels: [contract, enhancement, good-first-issue]
epic: E01
wave: 1
depends_on: []
---

## Summary

`register_task` accepts any `u32` for `lock_ledgers` and `ttl_ledgers` without validation. Both have values that are nonsensical or actively harmful, and the contract currently accepts all of them.

## Current behaviour

```rust
// register_task — neither parameter is checked
let task = Task {
    owner: owner.clone(),
    task_type,
    calldata,
    reward,
    deadline,
    ttl_ledgers,
    status: TaskStatus::Pending,
    claimer: None,
    claim_ledger: None,
    lock_ledgers,
};
```

Three bad inputs are accepted today:

**`lock_ledgers = 0`.** The lock window is zero ledgers wide, so `lock_expired` returns true immediately after any claim. Every keeper can instantly re-claim from every other keeper. The task can be churned indefinitely and the "first keeper to claim wins lock rights" property described in the README does not hold.

**`lock_ledgers` very large** (up to `u32::MAX`). The first keeper to claim holds the task until the deadline, with no possibility of takeover. If that keeper goes offline, the task is dead until `expire_task` becomes callable — the exact scenario the lock window exists to prevent. `lock_expired` uses `saturating_add`, so an enormous value does not overflow; it just never expires.

**`ttl_ledgers = 0`.** The storage entry is written with a zero TTL extension. Combined with the separate stranding bug, this is the fastest possible route to unrecoverable escrow.

## Expected behaviour

`register_task` rejects `lock_ledgers` and `ttl_ledgers` values outside a documented sane range, with a specific error.

## Suggested approach

Add named constants with reasoning, and a `InvalidTaskParams` error variant:

```rust
/// A lock window shorter than this gives the claiming keeper no realistic
/// chance to execute before another keeper can take the task away.
const MIN_LOCK_LEDGERS: u32 = 10; // ~50 seconds

/// A lock window longer than this lets one unresponsive keeper hold a task
/// hostage for the better part of a day.
const MAX_LOCK_LEDGERS: u32 = 17_280; // ~1 day

/// Persistent entries below this are not worth writing.
const MIN_TTL_LEDGERS: u32 = 1_000;
```

Pick the actual numbers deliberately and justify them in the PR description rather than copying the ones above verbatim — they are illustrative. The relevant facts: Stellar closes a ledger roughly every 5 seconds, and Soroban's maximum persistent entry TTL is bounded by network config.

Note that the `ttl_ledgers` lower bound interacts with the separate deadline-vs-TTL issue. If that one lands first, this issue only needs to add the `lock_ledgers` bounds; coordinate on the issues so the two PRs do not conflict.

## Acceptance criteria

- [ ] `lock_ledgers` below the minimum or above the maximum is rejected with a named error.
- [ ] `ttl_ledgers` below the minimum is rejected.
- [ ] Every bound is a named constant with a doc comment explaining the number.
- [ ] Tests cover each bound at the boundary — the largest rejected value and the smallest accepted value, for each parameter.
- [ ] The `register_task` doc comment documents the accepted ranges.
- [ ] The README integration snippet uses values inside the new ranges.

## Files

- `contracts/keeper-registry/src/lib.rs`
- `contracts/keeper-registry/src/test.rs`
- `README.md`
