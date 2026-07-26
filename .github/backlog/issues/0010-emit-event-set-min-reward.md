---
title: "feat(registry): emit an event from set_min_reward"
labels: [contract, enhancement, good-first-issue]
epic: E01
wave: 1
depends_on: []
---

## Summary

`set_min_reward` changes a parameter that gates whether `register_task` succeeds, but emits no event. Every other admin setter in the contract emits one. An off-chain client cannot learn the value changed without polling.

## Current behaviour

```rust
pub fn set_min_reward(e: Env, admin: Address, min_reward: i128) -> Result<(), KeeperError> {
    require_admin(&e, &admin)?;
    if min_reward < 0 {
        return Err(KeeperError::InvalidReward);
    }
    e.storage().instance().set(&DataKey::MinReward, &min_reward);
    log!(&e, "Min reward set to {}", min_reward);
    Ok(())
}
```

`log!` is diagnostic only and is not indexable. Compare with `set_fee_bps`, which does it properly:

```rust
let old_bps: u32 = e.storage().instance().get(&DataKey::FeeBps).unwrap_or(0);
e.storage().instance().set(&DataKey::FeeBps, &new_bps);
emit_fee_updated(&e, old_bps, new_bps);
```

## Why this matters

A dApp that registers tasks needs the current minimum to build a valid call. If the admin raises it, previously-valid registrations start failing with `InvalidReward` — which is also the error for a zero or negative reward, so the caller cannot tell the two apart from the error alone. Without an event, the only way to notice is to poll `min_reward()`.

This is also a consistency problem. Once one admin setter is silent, an indexer cannot treat "replay the event log" as a complete reconstruction of contract configuration.

## Expected behaviour

`set_min_reward` emits an event carrying the old and new values, matching the shape `emit_fee_updated` already uses.

## Suggested approach

```rust
pub fn emit_min_reward_updated(e: &Env, old_min: i128, new_min: i128) {
    e.events().publish(
        (symbol_short!("minrwd"), symbol_short!("admin")),
        (old_min, new_min),
    );
}
```

Note the topic constraint: `symbol_short!` allows at most 9 characters. Follow the existing two-topic `(verb, noun)` convention so the same event filters keep working — the admin-facing events in this contract all use `"admin"` as the second topic.

Read the old value before overwriting it, as `set_fee_bps` does.

## Acceptance criteria

- [ ] `set_min_reward` emits an event with the previous and new values.
- [ ] The topic pair follows the existing convention and fits in `symbol_short!`.
- [ ] A test asserts the event is emitted with correct old and new values, in the style of `test_set_fee_emits_event`.
- [ ] A test asserts no event is emitted when the call fails validation.
- [ ] The README events table lists the new event.

## Files

- `contracts/keeper-registry/src/lib.rs`
- `contracts/keeper-registry/src/test.rs`
- `README.md` — the events table

## Getting started

This is a good first issue. `test_set_fee_emits_event` in `contracts/keeper-registry/src/test.rs` is a working example of everything you need — read it first and follow the same shape.
