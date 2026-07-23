---
title: "fix(registry): get_fee_bps reports 300 while execute_task charges 0 when the fee is unset"
labels: [contract, bug, good-first-issue]
epic: E01
wave: 1
depends_on: []
---

## Summary

`get_fee_bps` and `execute_task` disagree about the default protocol fee when the `FeeBps` key is absent from instance storage. The view returns `300` (3%), the execution path applies `0`. Any off-chain consumer that trusts the view will compute the wrong net reward.

## Current behaviour

The two call sites use different fallbacks:

```rust
// execute_task — contracts/keeper-registry/src/lib.rs
let fee_bps: u32 = e.storage().instance().get(&DataKey::FeeBps).unwrap_or(0);
```

```rust
// get_fee_bps — contracts/keeper-registry/src/lib.rs
pub fn get_fee_bps(e: Env) -> u32 {
    e.storage()
        .instance()
        .get(&DataKey::FeeBps)
        .unwrap_or(300u32)
}
```

`initialize` always writes `FeeBps`, so on a correctly initialized contract the key is present and the two agree. The divergence is reachable in two ways:

1. The registry is queried before `initialize` has been called.
2. A future `upgrade` migrates storage and the key is dropped or renamed.

In both cases `get_fee_bps` reports a 3% fee that the contract will not actually charge. A keeper bot that pre-computes profitability from this view under-counts its own revenue; an indexer reconciling `TaskExecuted` amounts against the fee rate will see every row fail to reconcile.

## Expected behaviour

There is exactly one default fee, defined once, and every read of `FeeBps` goes through it. A caller cannot observe a fee rate that differs from the rate the contract would apply.

## Suggested approach

Introduce a single named constant and a private accessor, then use it from both places:

```rust
/// Protocol fee applied when `FeeBps` has never been written. Kept at zero so
/// an uninitialized or partially-migrated registry can never silently skim
/// from a keeper's reward.
pub const DEFAULT_FEE_BPS: u32 = 0;

fn fee_bps(e: &Env) -> u32 {
    e.storage()
        .instance()
        .get(&DataKey::FeeBps)
        .unwrap_or(DEFAULT_FEE_BPS)
}
```

Whether the shared default should be `0` or `300` is a judgement call, and the PR should state which it picked and why. The argument for `0`: a fee is a transfer of value away from the keeper, and defaulting to charging one on a contract whose configuration is unknown is the more surprising of the two failure modes. Either choice is acceptable as long as it is applied uniformly and documented.

## Acceptance criteria

- [ ] A single constant defines the default fee, with a doc comment explaining the choice.
- [ ] `execute_task` and `get_fee_bps` both read the fee through one shared helper.
- [ ] A test asserts `get_fee_bps()` equals the rate actually applied by `execute_task`, on a contract where `FeeBps` was never written.
- [ ] A test asserts the same equality after `set_fee_bps` has been called.
- [ ] The README storage table notes the default value.

## Files

- `contracts/keeper-registry/src/lib.rs`
- `contracts/keeper-registry/src/test.rs`
- `README.md` — the storage model table

## Definition of done

`cargo test --workspace` passes, and no code path reads `DataKey::FeeBps` directly with its own inline fallback.
