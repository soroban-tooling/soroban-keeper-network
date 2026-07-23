---
title: "feat(registry): emit an event from initialize"
labels: [contract, enhancement, good-first-issue]
epic: E01
wave: 1
depends_on: []
---

## Summary

`initialize` writes the admin, reward token, and fee rate — the entire trust configuration of the registry — and emits no event. An indexer replaying the event log has no starting state.

## Current behaviour

```rust
e.storage().instance().set(&DataKey::Admin, &admin);
e.storage()
    .instance()
    .set(&DataKey::RewardToken, &reward_token);
e.storage().instance().set(&DataKey::FeeBps, &fee_bps);
e.storage().instance().set(&DataKey::Paused, &false);
e.storage().instance().set(&DataKey::TaskCounter, &0u64);
e.storage().instance().extend_ttl(100_000, 100_000);

log!(&e, "KeeperRegistry initialized by {}", admin);
```

## Why this matters

Every other configuration change in the contract emits an old-value/new-value pair: `emit_fee_updated`, `emit_admin_transferred`, `emit_paused`. Those events are only useful to a consumer that knows the *initial* values, and there is currently no event that supplies them.

Concretely, an indexer that wants to answer "what fee was in effect when task 42 executed?" replays `FeeUpdated` events. If the fee was never changed, there are no events at all, and the indexer has to fall back to a live `get_fee_bps()` call — which returns present state, not historical state, and which currently has its own default-value bug. The event log should be self-sufficient.

The same applies to the reward token address, which is read on every escrow movement and is otherwise only discoverable through a view call.

## Expected behaviour

`initialize` emits a single event carrying the admin, reward token, and initial fee, so the event log alone is sufficient to reconstruct registry configuration from genesis.

## Suggested approach

```rust
pub fn emit_initialized(e: &Env, admin: &Address, reward_token: &Address, fee_bps: u32) {
    e.events().publish(
        (symbol_short!("init"), symbol_short!("admin")),
        (admin.clone(), reward_token.clone(), fee_bps),
    );
}
```

Emit after all the storage writes have landed, so the event describes committed state.

`initialize` is guarded against being called twice, so exactly one of these events can ever exist per contract instance. That is a useful property for consumers — state it in the doc comment.

## Acceptance criteria

- [ ] `initialize` emits an event with admin, reward token address, and initial fee.
- [ ] The event is emitted after the storage writes.
- [ ] A test asserts the event is emitted with correct values — `test_initialize_sets_state` is the natural place to extend.
- [ ] A test asserts no event is emitted on the second, rejected `initialize` call.
- [ ] The README events table lists the new event and notes that it is emitted at most once.

## Files

- `contracts/keeper-registry/src/lib.rs`
- `contracts/keeper-registry/src/test.rs`
- `README.md` — the events table

## Getting started

This is a good first issue and pairs naturally with the `set_min_reward`, `sweep_fees`, and `upgrade` event issues. If you want to take more than one, say so on the issues and open a single PR covering them — the changes are small and mechanically similar, and reviewing them together is easier than four separate PRs.
