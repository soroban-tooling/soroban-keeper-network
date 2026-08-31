---
title: "perf(registry): split Task into hot/cold storage entries"
labels: [contract, performance, advanced]
epic: E05
wave: 2
depends_on: [0105]
---

## Summary

`docs/STORAGE_LAYOUT.md` (issue 0105's survey) found that `save_task`
unconditionally re-serializes and writes the entire `Task` struct — including
`calldata` (up to 1024 bytes) and `task_type` — on every lifecycle mutation,
even though `increase_reward`, `extend_deadline`, `claim_task`,
`execute_task`, `cancel_task`, and `expire_task` never read or change either
field after registration. This issue tracks splitting `Task` into a hot
struct (read/written by every lifecycle call) and a cold struct (written once
at registration, read only off-chain).

## Proposed shape

```rust
// Hot: read/written by claim_task, execute_task, cancel_task, expire_task,
// increase_reward, extend_deadline.
DataKey::Task(u64) -> TaskHot {
    owner, reward, deadline, ttl_ledgers, status, claimer, claim_ledger, lock_ledgers
}

// Cold: written once by register_task, never rewritten.
DataKey::TaskCalldata(u64) -> TaskCold {
    task_type, calldata
}
```

## Migration considerations (required before implementation)

- **Already-persisted `Task` entries exist.** The testnet deployment
  (`DEPLOYMENTS.md`) has live tasks stored under the current single-key
  `Task(id)` shape. A contract upgrade that changes what `DataKey::Task(id)`
  deserializes to will fail to read any task registered before the upgrade
  (XDR shape mismatch), stranding in-flight tasks and their escrowed rewards.
- Any implementation MUST either:
  1. Version the storage read path (attempt the new hot/cold shape, fall back
     to decoding the legacy full-`Task` shape, migrating lazily on next write), or
  2. Ship as a `MAJOR` version bump (per `CONTRIBUTING.md`'s versioning
     policy: "breaking changes to storage layout") with an explicit,
     documented migration script run before cutover, with no tasks left
     in `Pending`/`Claimed` state at migration time.
- `get_task` and any other consumer of the full `Task` shape (keeper bot,
  future SDKs) need their return type/ABI reviewed — this is a breaking
  change to anything that decodes `Task` off the wire, not just an internal
  storage change.

## Acceptance criteria

- [ ] Migration strategy chosen and documented (lazy fallback vs. major-version
      cutover) with no path that silently drops or corrupts a pre-existing
      `Pending`/`Claimed` task.
- [ ] `claim_task`/`execute_task`/`cancel_task`/`expire_task`/
      `increase_reward`/`extend_deadline` read/write only the hot entry.
- [ ] A regression test proves a task registered under the pre-split shape
      remains reachable (or the migration path is exercised) after the change.
- [ ] `docs/ARCHITECTURE.md`'s storage layout table is updated to match.

## Files

- contracts/keeper-registry/src/lib.rs
- contracts/keeper-registry/src/test.rs
- docs/ARCHITECTURE.md
