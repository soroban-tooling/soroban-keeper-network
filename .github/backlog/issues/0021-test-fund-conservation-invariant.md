---
title: "test(registry): assert fund conservation across every lifecycle path"
labels: [testing, contract, security, intermediate]
epic: E02
wave: 1
depends_on: []
---

## Summary

No test asserts the contract's most important safety property: the registry's token balance always equals the sum of what it owes. `test_multi_keeper_end_to_end_conserves_funds` gets closest, but it checks participant balances rather than decomposing the contract's own balance against its obligations.

## The invariant

At every point between calls, the registry's token balance must equal:

```
balance(registry) == sum(reward of tasks in Pending or Claimed)
                   + sum(keeper credited balances)
                   + fees_accrued
```

Each term is money owed to someone:

- **Open task escrow** is owed to the task owner (via cancel or expire) or to a keeper (via execute).
- **Keeper balances** are owed to keepers on `withdraw_rewards`.
- **Accrued fees** are owed to the treasury on `sweep_fees`.

If the left side exceeds the right, funds are stranded — nobody can withdraw them. If the right side exceeds the left, the contract is insolvent and some claim will fail at transfer time, with whoever withdraws last absorbing the loss.

Everything else the contract does is bookkeeping in service of this equation.

## Why the existing test is not enough

`test_multi_keeper_end_to_end_conserves_funds` asserts that participants ended up with the right amounts after a specific happy-path sequence. That is a useful test, but:

- It checks the *outcome* of one path, not the invariant at each step.
- It does not decompose the contract's balance into its three obligations, so a bug that moves value between escrow and fees while keeping the total right would pass.
- It does not cover cancel or expire, where refunds leave the contract.

## Expected behaviour

A reusable assertion helper checks the invariant, and it is called after every state transition in a test that exercises all lifecycle paths.

## Suggested approach

Write the helper first:

```rust
/// Asserts the registry holds exactly what it owes. `open_task_ids` are the
/// tasks currently in Pending or Claimed; `keepers` are every address that has
/// ever been credited. Both must be supplied by the caller because the contract
/// deliberately exposes no way to enumerate them on-chain.
fn assert_solvent(
    env: &Env,
    client: &KeeperRegistryClient,
    token: &TokenClient,
    registry_id: &Address,
    open_task_ids: &[u64],
    keepers: &[Address],
) {
    let held = token.balance(registry_id);
    let escrow: i128 = open_task_ids
        .iter()
        .map(|id| client.get_task(id).reward)
        .sum();
    let credited: i128 = keepers.iter().map(|k| client.keeper_balance(k)).sum();
    let fees = client.fees_accrued();
    assert_eq!(
        held,
        escrow + credited + fees,
        "registry balance {} != escrow {} + credited {} + fees {}",
        held, escrow, credited, fees
    );
}
```

Then drive a scenario that touches every terminal state, asserting after each call:

1. Register three tasks with different rewards.
2. Cancel one.
3. Claim and execute the second.
4. Let the third pass its deadline, then expire it.
5. Withdraw the keeper's balance.
6. Sweep part of the accrued fees, then the rest.

The final state should be a registry balance of zero with no open tasks, no credited balances, and no accrued fees. Assert that explicitly — a clean zero at the end is a strong signal.

Also add a case with a `fee_bps` that produces rounding dust, to confirm the invariant survives the floor division in `split_reward`.

## Acceptance criteria

- [ ] A reusable solvency assertion helper exists in `test.rs`.
- [ ] It is called after every state-mutating call in a full-lifecycle test.
- [ ] The scenario covers register, cancel, claim, execute, expire, withdraw, and sweep.
- [ ] A variant runs with a fee rate that produces rounding dust.
- [ ] The test ends with the registry holding exactly zero.
- [ ] The helper's doc comment states the invariant it enforces.

## Files

- `contracts/keeper-registry/src/test.rs`

## Notes

This helper is the foundation for the property-based and fuzzing work later in the roadmap — those will drive random call sequences and assert this same invariant after each one. Writing it cleanly here pays off twice.
