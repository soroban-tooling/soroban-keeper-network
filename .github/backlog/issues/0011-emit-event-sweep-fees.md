---
title: "feat(registry): emit an event from sweep_fees"
labels: [contract, enhancement, good-first-issue]
epic: E01
wave: 1
depends_on: []
---

## Summary

`sweep_fees` moves protocol revenue out of the contract to an arbitrary treasury address and emits no event. It is the single largest value transfer the admin can perform, and it leaves no indexable record.

## Current behaviour

```rust
pub fn sweep_fees(
    e: Env,
    admin: Address,
    treasury: Address,
    amount: i128,
) -> Result<(), KeeperError> {
    require_admin(&e, &admin)?;
    // ... validation ...
    e.storage()
        .instance()
        .set(&DataKey::FeesAccrued, &(accrued - amount));
    reward_token(&e).transfer(&e.current_contract_address(), &treasury, &amount);

    log!(&e, "Swept {} fees to {}", amount, treasury);
    Ok(())
}
```

The only trace is a `log!`, which is diagnostic output rather than transaction meta and is compiled out of release builds.

## Why this matters

The token transfer itself is visible on-chain — the SAC emits its own transfer event — but that event does not say *why* the funds moved. From the outside, a sweep is indistinguishable from any other outbound transfer from the registry address, and the registry also transfers on `cancel_task`, `expire_task`, and `withdraw_rewards`.

That matters for three audiences:

- **Keepers**, who need confidence that the admin only ever removes accrued fees and never touches task escrow or credited balances. The contract enforces this with the `FeesAccrued` accumulator; the event is what makes the enforcement *auditable* rather than merely present.
- **A future treasury or governance contract**, which needs to account for revenue by reading the event log.
- **The tokenomics story in the README**, which states that fees "accumulate in the contract; admin sweeps to a treasury address". There is currently no way to verify that claim from chain data alone.

This is the same underlying gap as the missing `set_min_reward` event, but with real money attached.

## Expected behaviour

`sweep_fees` emits an event identifying the treasury, the amount swept, and the remaining accrued balance.

## Suggested approach

```rust
pub fn emit_fees_swept(e: &Env, treasury: &Address, amount: i128, remaining: i128) {
    e.events().publish(
        (symbol_short!("sweep"), symbol_short!("admin")),
        (treasury.clone(), amount, remaining),
    );
}
```

Including `remaining` lets a consumer reconcile against `fees_accrued()` without a second call, and makes a partial sweep self-describing.

Emit after the state write and before or after the transfer — but be aware of the ordering discussion in the CEI issues; keep the effects-before-interactions shape.

## Acceptance criteria

- [ ] `sweep_fees` emits an event with treasury, amount, and remaining accrued balance.
- [ ] The topic pair follows the existing `(verb, "admin")` convention and fits `symbol_short!`'s 9-character limit.
- [ ] A test sweeps a partial amount and asserts the event values, including that `remaining` matches a subsequent `fees_accrued()` call.
- [ ] A test asserts no event is emitted when the sweep is rejected for exceeding the accrued balance.
- [ ] The README events table lists the new event.

## Files

- `contracts/keeper-registry/src/lib.rs`
- `contracts/keeper-registry/src/test.rs`
- `README.md` — the events table

## Getting started

`test_sweep_fees_to_treasury` already exercises the happy path; extend it or add a sibling test. `test_set_fee_emits_event` shows how to assert on emitted events.
