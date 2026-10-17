# Requirements Document

## Introduction

This feature adds a mock price-feed contract for use in tests and fuzz targets within the
`soroban-keeper-network` repo. Tests for oracle-dependent logic need a contract stand-in whose
price, decimals, and timestamp can be controlled per asset. The mock implements the same interface
as the Reflector oracle client introduced by issue #0417 (`IReflectorOracle`), so it can be
substituted transparently wherever the real oracle client is used.

Because issue #0417 has not yet landed, this spec also scaffolds the minimal
`contracts/oracle-client` crate (a `Cargo.toml` and a `src/lib.rs` that defines the
`IReflectorOracle` trait and `PriceData` type). When #0417 lands it replaces `src/lib.rs`; the
mock in `src/mock.rs` remains unchanged. This stopgap is an explicit, temporary assumption
recorded under Requirement 5.

## Glossary

- **Mock**: A Soroban `#[contract]` / `#[contractimpl]` test double that stores state and exposes
  setter methods so tests can control its output.
- **OracleMock**: The specific mock contract defined in `contracts/oracle-client/src/mock.rs`.
- **IReflectorOracle**: The trait defined in `contracts/oracle-client/src/lib.rs` that mirrors the
  Reflector on-chain interface (`lastprice`, `decimals`).
- **PriceData**: A struct holding `price: i128` and `timestamp: u64`, returned by `lastprice`.
- **Asset**: A `soroban_sdk::Symbol` identifying a tradeable asset (e.g. `XLM`, `BTC`).
- **cfg-gate**: A Rust conditional-compilation attribute (`#[cfg(any(test, fuzzing))]`) that
  prevents a code path from appearing in release WASM artifacts.
- **testutils feature**: A Cargo feature flag that unlocks Soroban SDK test utilities; it is never
  enabled in a release build.
- **oracle-client crate**: The Rust crate at `contracts/oracle-client/` that owns both the
  `IReflectorOracle` interface and the `OracleMock`.
- **Caller**: Any test or fuzz harness that registers the `OracleMock` contract on a
  `soroban_sdk::Env` and exercises oracle-dependent logic through it.
- **Missing-data path**: The code path in a Caller that handles `None` returned by `lastprice`,
  representing an asset whose price is unavailable.

## Requirements

### Requirement 1: Per-Asset Configurable Price, Decimals, and Timestamp

**User Story:** As a test author, I want to set an arbitrary price, decimal precision, and
timestamp for any asset on the OracleMock, so that I can exercise oracle-dependent contract logic
under controlled, deterministic conditions.

#### Acceptance Criteria

1. THE OracleMock SHALL expose a setter method `set_price(asset: Symbol, price: i128, timestamp: u64)` that stores the price and timestamp for the named asset in contract storage.
2. THE OracleMock SHALL expose a setter method `set_decimals(decimals: u32)` that stores the global decimal precision in contract storage.
3. WHEN `lastprice(asset)` is called on the OracleMock and a price has been set for that asset, THE OracleMock SHALL return `Some(PriceData { price, timestamp })` using the most recently stored values for that asset.
4. WHEN `decimals()` is called on the OracleMock, THE OracleMock SHALL return the most recently stored decimal precision value.
5. WHEN `set_price` is called multiple times for the same asset, THE OracleMock SHALL return only the value from the most recent call on subsequent `lastprice` queries for that asset.

### Requirement 2: Missing-Data Path Support

**User Story:** As a test author, I want to instruct the OracleMock to return no price for a
specific asset, so that I can exercise the missing-data path in oracle-dependent contract logic.

#### Acceptance Criteria

1. THE OracleMock SHALL initialize with no price data for any asset, so that `lastprice` returns `None` for all assets before any `set_price` call.
2. THE OracleMock SHALL expose a method `clear_price(asset: Symbol)` that removes any stored price for the named asset.
3. WHEN `lastprice(asset)` is called on the OracleMock and no price has been set (or has been cleared) for that asset, THE OracleMock SHALL return `None`.

### Requirement 3: Reflector Interface Compliance

**User Story:** As a test author, I want the OracleMock to implement exactly the same interface as
the real Reflector oracle client, so that I can substitute it without changing the contract under
test.

#### Acceptance Criteria

1. THE OracleMock SHALL implement the `IReflectorOracle` trait defined in `contracts/oracle-client/src/lib.rs`.
2. THE IReflectorOracle trait SHALL declare `fn lastprice(env: Env, asset: Symbol) -> Option<PriceData>` as a required method.
3. THE IReflectorOracle trait SHALL declare `fn decimals(env: Env) -> u32` as a required method.
4. THE PriceData struct SHALL contain exactly two fields: `price: i128` and `timestamp: u64`.
5. WHEN the OracleMock is registered on a `soroban_sdk::Env` and invoked via the generated Soroban client, THE OracleMock SHALL respond to `lastprice` and `decimals` calls with the same return types as the real Reflector contract.

### Requirement 4: Release Artifact Exclusion

**User Story:** As a release engineer, I want the OracleMock to be absent from any WASM artifact
built for deployment, so that test scaffolding never ships to production.

#### Acceptance Criteria

1. THE OracleMock module (`src/mock.rs`) SHALL be compiled only when the `cfg` predicate `any(test, fuzzing)` is true.
2. THE oracle-client crate SHALL declare `crate-type = ["cdylib", "rlib"]` so that integration tests can link against the rlib form without requiring the mock to be compiled into a cdylib.
3. THE oracle-client crate SHALL gate all `OracleMock` symbols behind the `testutils` Cargo feature or `#[cfg(any(test, fuzzing))]` such that a `cargo build --release` of the crate produces no mock symbols in the resulting WASM.
4. IF the `testutils` feature is absent and the build target is WASM, THEN THE oracle-client crate SHALL compile without errors and without including OracleMock code.

### Requirement 5: No-std Compatibility

**User Story:** As a contract developer, I want the oracle-client crate to be `no_std`-compatible,
so that it follows the same constraints as all other contracts in this workspace and can be used in
WASM targets without a standard allocator.

#### Acceptance Criteria

1. THE oracle-client crate SHALL declare `#![no_std]` at its crate root.
2. THE oracle-client crate SHALL NOT introduce any dependency that requires `std` on non-test build paths.
3. WHILE the `testutils` feature is disabled, THE oracle-client crate SHALL compile successfully with `--target wasm32-unknown-unknown` and `--no-default-features`.

### Requirement 6: Reusability from Tests and Fuzz Harnesses

**User Story:** As a developer writing integration tests or fuzz targets, I want to import the
OracleMock from a single well-known location and register it on any `soroban_sdk::Env`, so that
oracle-dependent contract logic can be tested without duplication of mock logic.

#### Acceptance Criteria

1. THE oracle-client crate SHALL be listed as a `[dev-dependency]` (with `features = ["testutils"]`) in any workspace crate that needs the OracleMock in tests.
2. WHEN the `testutils` feature is enabled, THE OracleMock SHALL be re-exported from `contracts/oracle-client/src/mock.rs` at a stable path usable as `oracle_client::mock::OracleMock`.
3. THE OracleMock SHALL be registrable on a `soroban_sdk::Env` via the standard `env.register_contract(None, OracleMock)` pattern used by all other mocks in this workspace.
4. THE OracleMock setter methods (`set_price`, `clear_price`, `set_decimals`) SHALL be callable through the Soroban-generated client type so that tests need not invoke them through raw `env.invoke_contract`.

### Requirement 7: Stopgap oracle-client Crate Scaffold (Pre-#0417)

**User Story:** As a developer working before issue #0417 lands, I want a minimal
`contracts/oracle-client` crate that defines `IReflectorOracle` and `PriceData`, so that
`src/mock.rs` compiles and tests can be written today.

#### Acceptance Criteria

1. THE oracle-client crate SHALL provide `contracts/oracle-client/Cargo.toml` with package name `oracle-client`, edition `2021`, and dependencies on `soroban-sdk` matching the version pinned in the workspace.
2. THE oracle-client crate SHALL provide `contracts/oracle-client/src/lib.rs` that declares the `IReflectorOracle` trait and `PriceData` struct as described in Requirement 3.
3. WHEN issue #0417 lands and replaces `src/lib.rs` with its own implementation, THE mock in `src/mock.rs` SHALL remain unchanged and SHALL continue to compile against the replacement `lib.rs` without modification.
4. THE oracle-client crate SHALL NOT be added as a workspace member in the root `Cargo.toml` until #0417 lands; it SHALL be usable as a path dependency from dev-dependencies only.
