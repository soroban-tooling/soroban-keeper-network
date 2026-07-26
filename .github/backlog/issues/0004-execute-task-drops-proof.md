---
title: "fix(registry): execute_task discards the proof so TaskExecuted cannot carry it as the PRD requires"
labels: [contract, bug, intermediate]
epic: E01
wave: 1
depends_on: []
---

## Summary

`execute_task` takes a `proof: Bytes` argument, logs its **length**, and then throws it away. The PRD in README states the proof is part of the emitted event, and the whole transparency story of the project depends on it being recoverable off-chain. Right now it is not recoverable at all.

## Current behaviour

The proof reaches the function and goes nowhere durable:

```rust
// contracts/keeper-registry/src/lib.rs — execute_task
emit_task_executed(&e, task_id, &keeper, keeper_net);
log!(
    &e,
    "Task {} executed by {} net={} proof_len={}",
    task_id, keeper, keeper_net, proof.len()
);
```

And the emitter has no proof parameter:

```rust
pub fn emit_task_executed(e: &Env, task_id: u64, keeper: &Address, net_reward: i128) {
    e.events().publish(
        (symbol_short!("exec"), symbol_short!("task")),
        (task_id, keeper.clone(), net_reward),
    );
}
```

`log!` output is diagnostic only — it is not part of the transaction meta that clients index, and it is compiled out of release builds. So the proof is accepted, validated by nothing, stored nowhere, and emitted nowhere.

## What the spec says

README, FR-3:

> MUST emit `TaskExecuted` with net reward and proof bytes.

And the event table:

> | `TaskExecuted` | `("exec", "task")` | `(task_id, keeper, net_reward, proof)` |

The implementation matches neither.

## Why this matters

The README's own "Known Design Decisions" section says the MVP trusts the claimer to submit proof, with on-chain verification deferred to Phase 2. That trade-off is defensible **only if the proof is publicly visible**, so that a keeper submitting garbage can be identified after the fact. A proof that is silently discarded provides no accountability whatsoever, and the design decision as written is not actually implemented.

This also blocks the indexer work and the Phase 2 verifier, both of which need the proof to exist in event data.

## Expected behaviour

The proof bytes appear in the `TaskExecuted` event data, so any client reading transaction meta can retrieve them for a given `task_id`.

## Suggested approach

Add the parameter to the emitter and pass it through:

```rust
pub fn emit_task_executed(
    e: &Env,
    task_id: u64,
    keeper: &Address,
    net_reward: i128,
    proof: &Bytes,
) {
    e.events().publish(
        (symbol_short!("exec"), symbol_short!("task")),
        (task_id, keeper.clone(), net_reward, proof.clone()),
    );
}
```

Two things to consider and to address in the PR description:

1. **Cost.** Event data is charged against the transaction's resource budget, so an unbounded proof makes execution arbitrarily expensive for the keeper paying the fee. Emitting the proof pairs naturally with bounding its size. A cap in the low hundreds of bytes comfortably fits a 32-byte tx hash or a small state witness.
2. **Consumers.** Anything already decoding `TaskExecuted` as a 3-tuple will break. The keeper bot and `docs/DEMO.md` both reference this event; check whether they decode it positionally and update them in the same PR.

## Acceptance criteria

- [ ] `TaskExecuted` event data includes the proof bytes.
- [ ] A test executes a task and asserts the proof is present and byte-identical in the emitted event.
- [ ] Proof size is bounded, with the limit as a named constant and a dedicated error variant, and a test covers the over-limit rejection.
- [ ] README FR-3 and the event table match the implementation exactly.
- [ ] Any in-repo consumer that decodes `TaskExecuted` is updated.

## Files

- `contracts/keeper-registry/src/lib.rs` — `emit_task_executed`, `execute_task`
- `contracts/keeper-registry/src/test.rs`
- `README.md` — FR-3 and the events table
- `examples/keeper-bot/index.js` — if it decodes this event
- `docs/DEMO.md`
