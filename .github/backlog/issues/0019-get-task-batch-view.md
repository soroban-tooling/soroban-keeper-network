---
title: "feat(registry): add a bounded get_tasks batch view for indexers and bots"
labels: [contract, enhancement, intermediate]
epic: E01
wave: 1
depends_on: []
---

## Summary

Reading N tasks requires N separate `get_task` calls. Keeper bots and indexers both need to inspect ranges of tasks, and doing so one RPC round trip at a time is the dominant cost in their polling loop.

## Current behaviour

The only task read is single-key:

```rust
pub fn get_task(e: Env, task_id: u64) -> Result<Task, KeeperError> {
    load_task(&e, task_id)
}
```

A bot that wants to check the 50 most recent tasks makes 50 simulation calls. The example keeper bot avoids this by reconstructing state from events instead, which is why it re-scans a 1000-ledger window every round and re-processes tasks it has already handled — a workaround for a missing read primitive.

## Constraint: this must stay bounded

The README is explicit that unbounded iteration is not acceptable:

> **No unbounded iteration** — no `Vec<task_id>` scanned in O(n); queries are by key.

That constraint is about *storage* — the contract must not keep a growing list that every operation walks. It does not forbid a read-only view that reads a caller-specified, bounded set of keys. Each read is still O(1) by key; the caller just batches them.

The distinction matters and the PR should be explicit about it, because a reviewer reading only the README line will reasonably push back.

## Expected behaviour

A read-only view accepts a bounded set of task ids and returns what it finds, without failing the whole call because one id is missing.

## Suggested approach

```rust
/// Maximum ids accepted by `get_tasks`. Each id costs one storage read against
/// the transaction's resource budget; this bound keeps a batch read comfortably
/// inside a single simulation.
const MAX_BATCH_READ: u32 = 50;

/// Reads several tasks in one call. Ids that do not exist are omitted from the
/// result rather than failing the call, so a caller scanning a range does not
/// have to know in advance which ids are live.
pub fn get_tasks(e: Env, ids: Vec<u64>) -> Result<Vec<Task>, KeeperError> {
    // ...
}
```

Two design points worth deciding explicitly and writing down:

**Missing ids.** Skipping them makes range scanning easy but means the caller cannot tell which returned task corresponds to which requested id without checking. Returning `Vec<Option<Task>>` preserves the correspondence at the cost of a clunkier type. Either is defensible; pick one and say why.

**A range variant.** `get_tasks_range(from, count)` is more convenient for the common "scan recent tasks" case and avoids the caller building a `Vec`. Consider adding it alongside, still bounded by `MAX_BATCH_READ`.

Also consider a companion `is_claimable_batch`, since filtering for claimable tasks is the actual thing bots want and it returns far less data than full `Task` structs. If you think it belongs, open a follow-up issue rather than growing this one.

## Acceptance criteria

- [ ] A batch read view exists, bounded by a named constant with a doc comment justifying the limit.
- [ ] Exceeding the bound returns a typed error rather than truncating silently.
- [ ] Missing ids are handled per the documented policy, and the policy is in the doc comment.
- [ ] Tests cover: a full batch, a batch containing missing ids, an empty input, and an over-limit input.
- [ ] The PR description explains why this does not violate the no-unbounded-iteration rule.
- [ ] The README technical specifications document the new view.

## Files

- `contracts/keeper-registry/src/lib.rs`
- `contracts/keeper-registry/src/test.rs`
- `README.md`
