---
title: "feat(registry): emit an event from upgrade"
labels: [contract, enhancement, security, good-first-issue]
epic: E01
wave: 1
depends_on: []
---

## Summary

`upgrade` replaces the contract's executable code and emits nothing. There is no on-chain, indexable record that an upgrade happened or which WASM hash it moved to.

## Current behaviour

```rust
pub fn upgrade(e: Env, admin: Address, new_wasm_hash: BytesN<32>) -> Result<(), KeeperError> {
    require_admin(&e, &admin)?;
    e.deployer().update_current_contract_wasm(new_wasm_hash);
    log!(&e, "Contract upgraded by {}", admin);
    Ok(())
}
```

Note that the `log!` does not even include the hash — only who called it.

## Why this matters

An upgrade is the highest-privilege operation in the contract. It can change every rule that keepers and task owners rely on: the fee split, who may claim, whether escrow is refundable. The README's trust model rests on the fact that upgrades are admin-gated and visible:

> **Upgrade is admin-gated** — WASM upgrade requires admin auth; new WASM must be pre-uploaded.

Gated, yes. Visible, no. A keeper with funds credited in the contract has no event to watch to learn that the code governing those funds has changed. The ledger records the contract's code hash changing, but nothing correlates that to an intentional, admin-authorised action with a known target hash, and nothing lets a client subscribe to it the way it subscribes to every other state change.

An event also gives the future governance and timelock work something to reconcile against: a proposal approves a specific WASM hash, and the emitted event proves that hash is what actually shipped.

## Expected behaviour

`upgrade` emits an event carrying the admin that authorised it and the new WASM hash, before the executable is swapped.

## Suggested approach

```rust
pub fn emit_upgraded(e: &Env, admin: &Address, new_wasm_hash: &BytesN<32>) {
    e.events().publish(
        (symbol_short!("upgrade"), symbol_short!("admin")),
        (admin.clone(), new_wasm_hash.clone()),
    );
}
```

Emit **before** calling `update_current_contract_wasm`. Ordering matters here in a way it does not for the other events: once the executable is replaced, the remainder of the current invocation continues under semantics you should not assume anything about. Emitting first keeps the record independent of that.

Consider also recording the hash in instance storage so `version()` can be joined against a concrete deployed artifact. That is a larger change and belongs in its own issue if you think it is worth doing — mention it on this one rather than expanding scope.

## Acceptance criteria

- [ ] `upgrade` emits an event with the authorising admin and the new WASM hash.
- [ ] The event is published before `update_current_contract_wasm` is called, with a comment explaining why.
- [ ] A test asserts the event is emitted with the correct hash.
- [ ] A test asserts no event is emitted when a non-admin call is rejected — `test_upgrade_by_non_admin_fails` already covers the rejection, so extend it.
- [ ] The README events table lists the new event.

## Files

- `contracts/keeper-registry/src/lib.rs`
- `contracts/keeper-registry/src/test.rs`
- `README.md` — the events table
