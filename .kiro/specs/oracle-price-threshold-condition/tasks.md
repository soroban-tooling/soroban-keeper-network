# Tasks

## Feature: oracle-price-threshold-condition

## Overview

Eight sequential tasks scaffold the crate, implement `initialize` and `check`, write the full test suite, and verify the WASM build.

## Tasks

- [ ] 1. Scaffold the crate
  - Create `contracts/conditions/oracle-price-threshold/Cargo.toml` with `name = "oracle-price-threshold"`, `crate-type = ["cdylib", "rlib"]`, `soroban-sdk = "22.0.1"`, `oracle-client` path dependency, and `testutils` feature flag.
  - Create `contracts/conditions/oracle-price-threshold/src/lib.rs` with `#![no_std]`, the `ICondition` trait annotated `#[contractclient(name = "ConditionClient")]`, the `Direction` enum, `DataKey` enum, `ConditionError` enum, and the `OraclePriceThreshold` `#[contract]` struct declaration with empty `#[contractimpl]` stubs for `initialize` and `check`.
  - Verify the crate compiles with `cargo build --target wasm32-unknown-unknown --no-default-features`.

- [ ] 2. Implement `initialize`
  - Implement the `AlreadyInitialized` guard: read `DataKey::Initialized`; if `true`, return `ConditionError::AlreadyInitialized`.
  - Validate `threshold_e18 < 0` → return `ConditionError::InvalidThreshold`.
  - Apply `max_staleness_seconds == 0` → default `MAX_STALENESS_SECONDS` fallback.
  - Store all six configuration keys (`Oracle`, `Asset`, `Direction`, `ThresholdE18`, `MaxStaleness`, `Initialized`) to Persistent storage.
  - Extend instance TTL via `env.storage().instance().extend_ttl(CONDITION_BUMP_THRESHOLD, CONDITION_BUMP_LEDGERS)`.

- [ ] 3. Implement `check` — initialization guard
  - At the top of `check`, read `DataKey::Initialized`; if absent or `false`, return `false` immediately (fail closed, no panic).

- [ ] 4. Implement `check` — price fetch and staleness
  - Load `DataKey::Oracle` and `DataKey::Asset`; construct a `ReflectorClient`.
  - Call `oracle_client.lastprice(&asset)`; if `None`, return `false`.
  - Load `DataKey::MaxStaleness`.
  - If `price_data.timestamp > env.ledger().timestamp()`, return `false` (future-dated).
  - If `env.ledger().timestamp() - price_data.timestamp > max_staleness_seconds`, return `false`; exact equality is fresh (proceed).

- [ ] 5. Implement `check` — normalization
  - Call `oracle_client.decimals()` to obtain `oracle_decimals: u32`.
  - If `oracle_decimals > 18`, return `false`.
  - Compute scale factor via `10i128.checked_pow(18 - oracle_decimals)`; if `None`, return `false`.
  - Compute `price_e18 = price_data.price.checked_mul(scale)`; if `None`, return `false`.

- [ ] 6. Implement `check` — direction comparison
  - Load `DataKey::Direction` and `DataKey::ThresholdE18`.
  - Return `price_e18 > threshold_e18` for `Direction::Above`.
  - Return `price_e18 < threshold_e18` for `Direction::Below`.
  - Equality (`price_e18 == threshold_e18`) returns `false` for both directions.

- [ ] 7. Write tests in `src/test.rs`
  - Write `test_above_direction_crosses_threshold`: `Direction::Above`, price above threshold → `true`.
  - Write `test_above_direction_below_threshold`: price below threshold → `false`.
  - Write `test_below_direction_crosses_threshold`: `Direction::Below`, price below threshold → `true`.
  - Write `test_below_direction_above_threshold`: price above threshold → `false`.
  - Write `test_price_at_boundary_returns_false`: `price_e18 == threshold_e18`, both directions → `false`.
  - Write `test_staleness_boundary_fresh`: `now - timestamp == max_staleness_seconds` → comparison result.
  - Write `test_staleness_boundary_stale`: `now - timestamp == max_staleness_seconds + 1` → `false`.
  - Write `test_missing_price_returns_false`: `lastprice` returns `None` → `false`.
  - Write `test_future_dated_price_returns_false`: `timestamp > now` → `false`.
  - Write `test_oracle_decimals_7`: 7-decimal feed normalized correctly.
  - Write `test_oracle_decimals_18`: 18-decimal feed, scale factor = 1.
  - Write `test_oracle_decimals_gt_18`: `decimals = 19` → `false`.
  - Write `test_uninitialized_check_returns_false`: `check` before `initialize` → `false`.
  - Write `test_double_initialize_errors`: second `initialize` → `ConditionError::AlreadyInitialized`.
  - Write `test_negative_threshold_rejected`: `threshold_e18 = -1` → `ConditionError::InvalidThreshold`.
  - Write `test_custom_staleness_window`: `max_staleness_seconds = 3600`, boundary at exactly 3600 and at 3601.

- [ ] 8. Run tests and verify build
  - Run `cargo test` from the crate directory; all tests must pass.
  - Run `cargo build --target wasm32-unknown-unknown --release --no-default-features`; confirm clean compile and no `OracleMock` symbols in the output WASM.

# Implementation Plan: oracle-price-threshold-condition

## Task Dependency Graph

```json
{
  "waves": [
    {
      "wave": 1,
      "tasks": ["1"],
      "description": "Scaffold crate files and confirm baseline compilation"
    },
    {
      "wave": 2,
      "tasks": ["2"],
      "description": "Implement initialize entry point"
    },
    {
      "wave": 3,
      "tasks": ["3", "4", "5", "6"],
      "description": "Implement check: guard, price fetch, normalization, comparison"
    },
    {
      "wave": 4,
      "tasks": ["7"],
      "description": "Write full test suite"
    },
    {
      "wave": 5,
      "tasks": ["8"],
      "description": "Verify tests pass and WASM build is clean"
    }
  ]
}
```

Tasks 3–6 may be implemented in a single pass but are listed separately to make each logical step reviewable in isolation.

## Notes

- `oracle-client` is a path dev-dependency only until #0417 and #0418 are closed; do not add either crate to the workspace `[members]` array.
- The `check` method must never panic — every error path returns `false`. Only `initialize` returns a typed error.
- `Direction`, `DataKey`, `ConditionError`, and `ICondition` are all declared in `src/lib.rs`; there is no separate `types.rs` given the small surface area.
- The staleness constant `MAX_STALENESS_SECONDS = 86_400` and bump constants `CONDITION_BUMP_LEDGERS = 100_000` / `CONDITION_BUMP_THRESHOLD = 50_000` are defined as `pub const` in `src/lib.rs`.
