# Implementation Plan: oracle-mock-price-feed

## Overview

Scaffold the `contracts/oracle-client` crate: a `Cargo.toml`, a stopgap `src/lib.rs` that
declares the `IReflectorOracle` trait and `PriceData` type, and a cfg-gated `src/mock.rs`
that implements the `OracleMock` contract. Close with a smoke-test task and optional
property-based tests that validate the five correctness properties from the design.

The crate is NOT added to the workspace `[members]` array (Requirement 7.4). Consumers
reference it as a path dev-dependency with `features = ["testutils"]`.

---

## Tasks

- [ ] 1. Create `contracts/oracle-client/Cargo.toml`
  - Create the directory `contracts/oracle-client/` and write `Cargo.toml` exactly as
    specified in the design's "Crate Cargo.toml Specification" section.
  - Package name: `oracle-client`, edition `2021`, `crate-type = ["cdylib", "rlib"]`.
  - Features: `default = []`, `testutils = ["soroban-sdk/testutils"]`.
  - Dependency: `soroban-sdk = { version = "22.0.1" }` — pin to the version already
    used by `keeper-registry` (no range).
  - Include `[lints.rust] unexpected_cfgs` suppression for `cfg(fuzzing)`, matching the
    pattern in `contracts/keeper-registry/Cargo.toml`.
  - Do NOT add `oracle-client` to the root `Cargo.toml` `[members]` array.
  - _Requirements: 7.1, 7.4, 4.2, 5.2_

- [ ] 2. Implement `contracts/oracle-client/src/lib.rs` — interface and types (stopgap)
  - [ ] 2.1 Declare `PriceData` and `IReflectorOracle`
    - Open with `#![no_std]` (Requirement 5.1).
    - Add the `// STOPGAP` header comment as specified in the design's Implementation Notes.
    - Declare `PriceData` with `#[contracttype]` + `#[derive(Clone, Debug)]`; fields
      `price: i128` and `timestamp: u64` exactly (Requirement 3.4).
    - Declare `IReflectorOracle` trait with
      `#[cfg_attr(feature = "testutils", contractclient(name = "ReflectorClient"))]`;
      required methods `lastprice(env: Env, asset: Symbol) -> Option<PriceData>` and
      `decimals(env: Env) -> u32` (Requirements 3.2, 3.3).
    - Declare the `mock` module with `#[cfg(any(test, fuzzing))] pub mod mock;`
      so the mock is reachable at `oracle_client::mock::OracleMock` (Requirement 6.2).
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 5.1, 7.2_

  - [ ]* 2.2 Write unit test: `#[no_std]` compile guard
    - Add an inline `#[cfg(test)] mod tests` block that simply imports `PriceData` and
      constructs one, asserting `price` and `timestamp` round-trip through the struct.
      This is a cheap compile-time check that `no_std` + `#[contracttype]` coexist.
    - _Requirements: 5.1, 3.4_

- [ ] 3. Implement `contracts/oracle-client/src/mock.rs` — `OracleMock` contract
  - [ ] 3.1 Scaffold `DataKey`, `OracleMock` struct, and module-level cfg gate
    - Open the file with `#![cfg(any(test, fuzzing))]` (Requirement 4.1).
    - Declare `DataKey` enum with `#[contracttype]` + `#[derive(Clone)]`;
      variants `Price(Symbol)` and `Decimals` (design Data Models section).
    - Declare `OracleMock` struct with `#[contract]`.
    - _Requirements: 4.1, 4.3_

  - [ ] 3.2 Implement `IReflectorOracle` interface methods
    - In a `#[contractimpl]` block, implement `lastprice(env: Env, asset: Symbol) -> Option<PriceData>`:
      read `DataKey::Price(asset)` from persistent storage with `.get()`, return directly
      (key absence maps to `None`).
    - Implement `decimals(env: Env) -> u32`: read `DataKey::Decimals` with
      `.get().unwrap_or(7)` so a fresh mock defaults to Reflector's standard 7.
    - _Requirements: 1.3, 1.4, 2.1, 2.3, 3.1, 3.5_

  - [ ] 3.3 Implement setter and clearer control methods
    - Implement `set_price(env: Env, asset: Symbol, price: i128, timestamp: u64)`:
      construct `PriceData { price, timestamp }` and write to `DataKey::Price(asset)` in
      persistent storage (Requirements 1.1, 1.5 — last write wins).
    - Implement `set_decimals(env: Env, decimals: u32)`: write to `DataKey::Decimals`
      in persistent storage (Requirement 1.2).
    - Implement `clear_price(env: Env, asset: Symbol)`: call `.remove()` on
      `DataKey::Price(asset)` from persistent storage; `.remove()` on an absent key is a
      no-op (Requirement 2.2).
    - All three are unconditional writes/removes — no input validation (design Error
      Handling section).
    - _Requirements: 1.1, 1.2, 1.5, 2.2, 6.4_

- [ ] 4. Checkpoint — verify the crate compiles in all relevant configurations
  - Ensure all tests pass, ask the user if questions arise.
  - Run `cargo build -p oracle-client` (no features, rlib/cdylib, no mock).
  - Run `cargo build -p oracle-client --features testutils` (with client derive).
  - Run `cargo test -p oracle-client` (mock compiled, unit tests pass).
  - Confirm there are no `unexpected_cfgs` warnings about `fuzzing`.

- [ ] 5. Write inline unit tests in `src/mock.rs`
  - [ ] 5.1 Concrete example tests
    - Add a `#[cfg(test)] mod tests` block inside `src/mock.rs`.
    - Test: register `OracleMock`, call `set_price`, assert `lastprice` returns
      `Some(PriceData { price, timestamp })` with the correct values.
    - Test: call `set_decimals(18)`, assert `decimals()` returns `18`.
    - Test: call `clear_price`, assert `lastprice` returns `None`.
    - Test: on a fresh mock, assert `decimals()` returns `7` (default).
    - Test: on a fresh mock, assert `lastprice` for an unset asset returns `None`.
    - _Requirements: 1.3, 1.4, 2.1, 2.2, 2.3_

  - [ ]* 5.2 Write property test for Property 1 — price set–get round-trip
    - Use `proptest` (already in `keeper-registry`'s dev-deps; add to oracle-client
      `[dev-dependencies]` at `proptest = "1"`).
    - For any asset `Symbol` (short 1–10 char string), `price: i128`, `timestamp: u64`:
      `set_price` → `lastprice` → assert `Some(PriceData { price, timestamp })`.
    - **Property 1: Price set–get round-trip**
    - **Validates: Requirements 1.1, 1.3, 3.5, 6.4**

  - [ ]* 5.3 Write property test for Property 2 — decimal set–get round-trip
    - For any `decimals: u32`: `set_decimals` → `decimals()` → assert returned value
      equals stored value.
    - **Property 2: Decimal set–get round-trip**
    - **Validates: Requirements 1.2, 1.4**

  - [ ]* 5.4 Write property test for Property 3 — last-write wins on repeated `set_price`
    - For any asset `Symbol` and two `(price, timestamp)` pairs P1 and P2:
      `set_price(P1)` → `set_price(P2)` → `lastprice` → assert `Some(P2)`.
    - **Property 3: Last-write wins on repeated set_price**
    - **Validates: Requirements 1.5**

  - [ ]* 5.5 Write property test for Property 4 — fresh mock returns `None` for all assets
    - For any asset `Symbol` on a freshly registered `OracleMock` (no `set_price`):
      `lastprice(asset)` → assert `None`.
    - **Property 4: Fresh mock returns None for all assets**
    - **Validates: Requirements 2.1, 2.3**

  - [ ]* 5.6 Write property test for Property 5 — set then clear restores `None`
    - For any asset `Symbol`, `price: i128`, `timestamp: u64`:
      `set_price` → `clear_price` → `lastprice` → assert `None`.
    - **Property 5: set_price then clear_price restores None**
    - **Validates: Requirements 2.2, 2.3**

- [ ] 6. Add documentation in `docs/ORACLE_MOCK.md`
  - [ ] 6.1 Create `docs/ORACLE_MOCK.md`
    - Document the purpose of the `oracle-client` crate (stopgap scaffold, replaced by #0417).
    - Show the minimal `[dev-dependencies]` snippet a consumer must add.
    - Show the three-step usage pattern: `env.register_contract` → `set_price` /
      `set_decimals` → exercise contract under test.
    - Note the `clear_price` / `None`-return path for missing-data testing.
    - Note the TTL caveat from the design's Implementation Notes (tests that fast-forward
      the ledger must extend TTLs manually or use `env.ledger().set_sequence_number()`).
    - Reference that `OracleMock` is reachable at `oracle_client::mock::OracleMock`.
    - _Requirements: 6.1, 6.2, 6.3, 7.3_

- [ ] 7. Final smoke-test checkpoint
  - Ensure all tests pass, ask the user if questions arise.
  - Run `cargo test -p oracle-client` and confirm all example tests and any enabled
    property tests pass.
  - Run `cargo build -p oracle-client --target wasm32-unknown-unknown --no-default-features`
    and confirm no `std`, no mock symbols, and no errors (Requirements 5.2, 5.3, 4.4).
  - Confirm the root `Cargo.toml` has NOT been modified (Requirement 7.4).

---

## Notes

- Tasks marked with `*` are optional and can be skipped for a faster MVP. The five
  property-test sub-tasks (5.2–5.6) each target a single correctness property from the design.
- The crate must NOT be added to the workspace `[members]` array — consumers use
  `oracle-client = { path = "../oracle-client", features = ["testutils"] }` in their
  `[dev-dependencies]`.
- `proptest` is only needed if any `*`-marked property tests (5.2–5.6) are implemented;
  add it to `[dev-dependencies]` only then.
- The `#[contractclient]` derive in `lib.rs` is conditional on the `testutils` feature so
  the trait remains available in WASM builds without generating the client struct.
- `clear_price` on an absent key is always a no-op — no error handling needed.
- The default decimals value of `7` matches Reflector's on-chain default; tests that never
  call `set_decimals` get a sensible result automatically.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["2.1"] },
    { "id": 1, "tasks": ["3.1"] },
    { "id": 2, "tasks": ["2.2", "3.2", "3.3"] },
    { "id": 3, "tasks": ["5.1", "6.1"] },
    { "id": 4, "tasks": ["5.2", "5.3", "5.4", "5.5", "5.6"] }
  ]
}
```
