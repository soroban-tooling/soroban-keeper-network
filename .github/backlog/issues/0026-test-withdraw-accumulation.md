---
title: "test(registry): assert keeper balances accumulate across tasks and withdraw as one sum"
labels: [testing, contract, good-first-issue]
epic: E02
wave: 1
depends_on: []
---

## Summary

The design credits keepers to an internal balance so they can execute many tasks and pay one withdrawal fee. No test executes more than one task per keeper before withdrawing, so the accumulation itself is unverified.

## Current coverage

- `test_withdraw_transfers_balance_and_zeroes_it` — one task, one withdrawal.
- `test_double_withdraw_fails` — second withdrawal rejected.
- `test_withdraw_with_no_balance_fails`.

Each involves exactly one credit.

## The gap

`credit_keeper` is written to accumulate:

```rust
let current: i128 = e.storage().persistent().get(&key).unwrap_or(0);
let updated = current
    .checked_add(amount)
    .expect("keeper balance overflow");
e.storage().persistent().set(&key, &updated);
```

The `unwrap_or(0)`-then-add is the accumulation, and nothing tests the second iteration. A regression that overwrote instead of adding — `set(&key, &amount)` — would pass the entire existing suite while silently discarding every reward but the last.

That failure mode is quiet and expensive. A keeper executing tasks all day would see only its most recent reward on withdrawal, and would have no on-chain evidence of what went missing beyond summing `TaskExecuted` events itself.

The README states the property as a scalability feature:

> Reward balance is aggregated per keeper — single persistent entry regardless of tasks executed.

## Expected behaviour

A test executes several tasks as one keeper and asserts the credited balance is the exact sum of the net rewards.

## Suggested approach

```
1. Register three tasks with distinct rewards — use different values so an
   off-by-one or an overwrite is unambiguous in the assertion.
2. Claim and execute all three with the same keeper.
3. After each execution, assert keeper_balance equals the running sum of net
   rewards so far. Asserting after each step localises a failure.
4. Withdraw once. Assert:
   - the transferred amount equals the full sum
   - keeper_balance is now zero
   - exactly one RewardsWithdrawn event was emitted, carrying the total
5. Assert fees_accrued equals the sum of the three fees.
```

Add a second keeper executing its own tasks in the same test, and assert the two balances stay independent. `DataKey::KeeperReward(Address)` keys per address, so this should hold — but nothing currently proves the keys do not collide.

Use rewards that produce non-round fee splits, so the sum exercises the rounding in `split_reward` rather than only clean multiples.

## Acceptance criteria

- [ ] A test executes at least three tasks with one keeper and asserts the running balance after each.
- [ ] A single withdrawal transfers the full accumulated sum and zeroes the balance.
- [ ] Exactly one `RewardsWithdrawn` event is emitted, carrying the total.
- [ ] A second keeper's balance is asserted to be independent.
- [ ] Rewards are chosen so fee rounding is exercised.
- [ ] `fees_accrued` is asserted against the sum of the individual fees.

## Files

- `contracts/keeper-registry/src/test.rs`

## Getting started

Good first issue. `test_withdraw_transfers_balance_and_zeroes_it` is the starting point — the change is looping the register/claim/execute sequence before withdrawing.
