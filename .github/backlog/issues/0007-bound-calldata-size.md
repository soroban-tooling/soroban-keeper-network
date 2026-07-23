---
title: "feat(registry): bound calldata size at registration"
labels: [contract, enhancement, intermediate]
epic: E01
wave: 1
depends_on: []
---

## Summary

`Task.calldata` is an unbounded `Bytes`. A caller can register a task with an arbitrarily large payload, and every subsequent operation on that task pays to load and re-write it.

## Current behaviour

`calldata` goes straight from the argument into the stored struct with no length check:

```rust
pub struct Task {
    pub owner: Address,
    pub task_type: TaskType,
    /// Arbitrary bytes the keeper uses to reconstruct the target call off-chain.
    pub calldata: Bytes,
    ...
}
```

## Why this matters

`save_task` writes the **entire** `Task` struct on every mutation — claim, execute, cancel, expire, reward top-up, deadline extension. So a large `calldata` is not paid for once at registration; it is re-serialised and re-written on every state transition, and re-read by `load_task` on every call including the read-only views.

That cost falls on whoever makes the call, which is frequently **not** the task owner:

- A keeper pays it on `claim_task` and `execute_task`.
- Any passer-by pays it on `expire_task`, which is permissionless.

So an owner can register a task with a multi-kilobyte payload and a trivial reward, and the resource cost of touching it is borne by keepers. At minimum this is a griefing vector against keepers; combined with a `min_reward` of zero, it is cheap to do in bulk.

The Soroban host imposes its own transaction resource limits, which bound the worst case — but those limits are network configuration that can change, and relying on them means the contract's cost profile is defined somewhere other than the contract.

## Expected behaviour

`register_task` rejects `calldata` above a documented maximum, so the per-task cost of every lifecycle operation has a known ceiling.

## Suggested approach

```rust
/// Maximum `calldata` length. Sized to hold an encoded contract call — a
/// target address, a function symbol, and a handful of scalar arguments —
/// without letting a task owner push storage and re-serialisation cost onto
/// the keepers and passers-by who call into the task later.
const MAX_CALLDATA_LEN: u32 = 1024;
```

Add a `CalldataTooLarge` error variant and check `calldata.len()` in `register_task`.

Choosing the number is the interesting part of this issue. Look at what a realistic task actually needs to encode for each `TaskType` variant and size the limit from that, with headroom. Put the reasoning in the PR description; a limit nobody can justify will just be raised the first time someone hits it.

Consider whether payloads genuinely larger than the cap should be supported by storing a hash on-chain and the payload off-chain. If you think so, note it on the issue rather than building it here.

## Acceptance criteria

- [ ] `register_task` rejects oversized `calldata` with a dedicated error variant.
- [ ] The limit is a named constant with a doc comment justifying the value.
- [ ] Tests cover the largest accepted payload and the smallest rejected one.
- [ ] A test asserts an empty `calldata` is still accepted, if that is the intended behaviour — decide and document it either way.
- [ ] The limit is documented in the README technical specifications.

## Files

- `contracts/keeper-registry/src/lib.rs`
- `contracts/keeper-registry/src/test.rs`
- `README.md`
