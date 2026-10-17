# Requirements Document

## Introduction

This feature implements the `oracle-price-threshold` condition contract
(`contracts/conditions/oracle-price-threshold/`), which gates a keeper's ability to claim
a task until an asset's price on the Reflector oracle crosses an owner-chosen threshold. It
builds on the `oracle-client` crate introduced by issues #0417 and #0418, and it implements
the condition interface that issues #0390 and #0393 specify the registry's `claim_task` will
call.

Because issues #0416 (`ORACLE_DESIGN.md`) and #0390 (`TASK_CONDITIONS_DESIGN.md`) are not
yet closed, this spec records all design decisions that those documents would otherwise
supply — staleness rule, normalization arithmetic, and condition interface shape — so
implementation can proceed without waiting for those documents.

**Defaults adopted (user skipped clarifying questions):**

| Topic | Decision | Rationale |
|---|---|---|
| Staleness rule | Fail closed; stale → `check` returns `false` | Conservative posture matching the registry's default-zero / never-silently-wrong philosophy |
| Staleness window | `MAX_STALENESS_SECONDS = 86_400` (86,400 s ≈ 1 day) | Matches `TTL_SAFETY_MARGIN_LEDGERS = 17_280 × 5 s` already in `constants.rs` |
| Normalization base | 18-decimal fixed-point | Industry-standard; avoids per-call `decimals()` queries affecting stored threshold semantics |
| Normalization formula | `price_e18 = price × 10^(18 − oracle_decimals)`; threshold stored as `i128` in the same 18-decimal base | Deterministic; integer-only arithmetic; no floating point |
| Condition interface | `fn check(env: Env, task_id: u64) -> bool` with `#[contractclient(name = "ConditionClient")]` | Direct analogue of `IKeeperVerifier`'s `fn verify(…) -> bool` |
| Configuration | Deploy-time only via `initialize(oracle, asset, direction, threshold_e18, max_staleness_seconds)` | Immutable after deploy; owner cannot swap oracle post-deploy |

## Glossary

- **ICondition**: The cross-contract interface the registry calls to evaluate a task's
  condition. Declared in `contracts/conditions/oracle-price-threshold/src/lib.rs`.
- **IReflectorOracle**: The oracle interface declared in `contracts/oracle-client/src/lib.rs`
  (`lastprice`, `decimals`).
- **PriceData**: `{ price: i128, timestamp: u64 }` returned by `IReflectorOracle::lastprice`.
- **price_e18**: The oracle price scaled to 18-decimal fixed-point for comparison:
  `price × 10^(18 − oracle_decimals)`.
- **threshold_e18**: The owner-configured threshold expressed in the same 18-decimal base.
- **Direction**: `Above` (claimable when `price_e18 > threshold_e18`) or `Below` (claimable
  when `price_e18 < threshold_e18`).
- **Staleness window**: The maximum age of a `PriceData.timestamp` (in seconds) before the
  price is treated as stale.
- **MAX_STALENESS_SECONDS**: `86_400` — the default staleness ceiling (≈ 1 day).
- **Fail closed**: A stale or missing price causes `check` to return `false`; the claim is
  refused.
- **oracle_decimals**: `IReflectorOracle::decimals()` — the number of decimal places the
  oracle uses (Reflector default: 7).
- **Condition contract**: The `oracle-price-threshold` contract deployed per-task by the
  task owner; a single contract instance serves a single `(oracle, asset, direction,
  threshold_e18, max_staleness_seconds)` configuration.
- **Caller**: The registry's `claim_task` function, which constructs a `ConditionClient` and
  calls `check(task_id)` when the task carries a condition address.

## Requirements

### Requirement 1: Condition Interface

**User Story:** As the keeper registry, I want a single stable `ICondition` interface so that
`claim_task` can evaluate any condition contract without knowing its internals.

#### Acceptance Criteria

1. THE `oracle-price-threshold` crate SHALL declare a trait named `ICondition` annotated with `#[contractclient(name = "ConditionClient")]` that generates a `ConditionClient` typed-client struct for use in tests and in the registry.
2. THE `ICondition` trait SHALL declare exactly one required method: `fn check(env: Env, task_id: u64) -> bool`.
3. THE `OraclePriceThreshold` contract SHALL implement `ICondition` and SHALL be the sole exported `#[contract]` in `src/lib.rs`.
4. THE `check` method SHALL NOT require any authorization — it is a read-only predicate callable by anyone.
5. THE interface type SHALL be declared in `contracts/conditions/oracle-price-threshold/src/lib.rs` so future condition contracts can re-export it without depending on the condition's implementation.

### Requirement 2: Deploy-Time Configuration

**User Story:** As a task owner, I want to deploy a condition contract with a fixed oracle
address, asset, direction, and threshold so that the condition is fully determined at deploy
time and cannot be mutated afterward.

#### Acceptance Criteria

1. THE `OraclePriceThreshold` contract SHALL expose an `initialize` entry point with the signature `fn initialize(env: Env, oracle: Address, asset: Symbol, direction: Direction, threshold_e18: i128, max_staleness_seconds: u64) -> Result<(), ConditionError>`.
2. THE `initialize` entry point SHALL store each parameter in contract Persistent storage under a `DataKey` enum variant.
3. WHEN `initialize` is called a second time on the same contract instance, THE contract SHALL return `ConditionError::AlreadyInitialized` without modifying any stored configuration.
4. THE `threshold_e18` parameter SHALL be interpreted as an `i128` in 18-decimal fixed-point; negative values SHALL be rejected with `ConditionError::InvalidThreshold`.
5. THE `Direction` type SHALL be a `#[contracttype]` enum with exactly two variants: `Above` and `Below`.
6. THE `max_staleness_seconds` parameter SHALL default to `MAX_STALENESS_SECONDS` (86,400) when callers pass `0`; passing a non-zero value SHALL override the default for that instance.

### Requirement 3: Price Fetch and Staleness Check

**User Story:** As a keeper, I want the condition contract to fetch the asset's price at call
time from the configured oracle so that the evaluation reflects the current on-chain state
and cannot be manipulated by caller-supplied data.

#### Acceptance Criteria

1. WHEN `check` is called, THE contract SHALL call `IReflectorOracle::lastprice(asset)` on the configured oracle address; it SHALL NOT use any cached price from its own storage.
2. WHEN `lastprice` returns `None` (asset unknown to the oracle), THE `check` method SHALL return `false` (fail closed).
3. WHEN `lastprice` returns `Some(PriceData { price, timestamp })` and `env.ledger().timestamp() − timestamp > max_staleness_seconds`, THE `check` method SHALL return `false` (fail closed).
4. WHEN `lastprice` returns a timestamp strictly greater than `env.ledger().timestamp()` (future-dated), THE `check` method SHALL return `false` (fail closed — future timestamps are invalid).
5. WHEN the price's age is exactly equal to `max_staleness_seconds` (i.e., `env.ledger().timestamp() − timestamp == max_staleness_seconds`), THE `check` method SHALL return the direction comparison result (price is at the boundary and is considered fresh).
6. THE `check` method SHALL call `IReflectorOracle::decimals()` on the configured oracle to obtain `oracle_decimals` at call time, so a feed that changes its precision is handled correctly.

### Requirement 4: Price Normalization and Threshold Comparison

**User Story:** As a task owner, I want the threshold to be expressed in a stable 18-decimal
base so that I do not need to know the oracle's native decimal precision when I register the
task.

#### Acceptance Criteria

1. THE contract SHALL compute `price_e18 = price.checked_mul(10i128.pow(18 − oracle_decimals))` where `price` is `PriceData.price` and `oracle_decimals` is the value returned by `IReflectorOracle::decimals()`.
2. WHEN `oracle_decimals` is already `18`, THE scaling factor SHALL be `1` (no multiplication), so `price_e18 == price`.
3. WHEN `oracle_decimals` is greater than `18`, THE contract SHALL return `false` without panicking — overflow in the normalization formula is treated as an invalid price (fail closed).
4. WHEN `direction` is `Above`, THE `check` method SHALL return `true` if and only if `price_e18 > threshold_e18`.
5. WHEN `direction` is `Below`, THE `check` method SHALL return `true` if and only if `price_e18 < threshold_e18`.
6. A price exactly equal to `threshold_e18` SHALL return `false` for both directions (equality is not a crossing).

### Requirement 5: Error Types

**User Story:** As an integrator, I want typed errors so that callers can distinguish
misconfiguration from runtime oracle failures.

#### Acceptance Criteria

1. THE crate SHALL declare a `ConditionError` enum annotated with `#[contracterror]` containing at least: `AlreadyInitialized = 1`, `NotInitialized = 2`, `InvalidThreshold = 3`.
2. WHEN any entry point (other than `check`) is called before `initialize`, THE contract SHALL return `ConditionError::NotInitialized`.
3. THE `check` method SHALL NOT return an error type; stale, missing, or invalid prices manifest as `false`, not as panics or contract errors.

### Requirement 6: Storage Layout

**User Story:** As a contract developer, I want a well-defined Persistent storage layout so
that the contract's footprint can be reviewed and TTL management can be planned.

#### Acceptance Criteria

1. THE contract SHALL use a `DataKey` enum annotated with `#[contracttype]` with variants: `Oracle`, `Asset`, `Direction`, `ThresholdE18`, `MaxStalenessSeconds`, `Initialized`.
2. ALL configuration keys SHALL use Persistent storage.
3. THE `check` method SHALL NOT write to storage; it is a pure read path.
4. THE `initialize` method SHALL extend the instance TTL by a constant `CONDITION_BUMP_LEDGERS` (value: `100_000`, matching `INSTANCE_BUMP_LEDGERS` in `contracts/keeper-registry/src/constants.rs`) after storing the configuration.

### Requirement 7: Crate Structure and Build Constraints

**User Story:** As a release engineer, I want the condition crate to follow the same build
constraints as every other contract in this workspace.

#### Acceptance Criteria

1. THE crate SHALL be located at `contracts/conditions/oracle-price-threshold/` with a `Cargo.toml` that sets `name = "oracle-price-threshold"`, `crate-type = ["cdylib", "rlib"]`, and depends on `soroban-sdk = "22.0.1"` and `oracle-client` as a path dependency.
2. THE crate SHALL declare `#![no_std]` at its root.
3. THE crate SHALL NOT be added to the workspace `[members]` array in the root `Cargo.toml` until the dependencies it waits on (#0417, #0418) are closed — it is usable as a path dev-dependency before then.
4. THE release profile settings (`opt-level = "z"`, `overflow-checks = true`, `panic = "abort"`, `lto = true`) SHALL be inherited from the workspace `[profile.release]` without redeclaring them.
5. THE crate SHALL expose a `testutils` Cargo feature that enables `soroban-sdk/testutils` and `oracle-client/testutils` for test and fuzz consumers.

### Requirement 8: Test Coverage

**User Story:** As a contributor, I want a `test.rs` that exercises every branch of `check`
so that regressions are caught at CI time.

#### Acceptance Criteria

1. THE test module SHALL contain a test named `test_above_direction_crosses_threshold` that sets a mock oracle price above the configured threshold and asserts `check` returns `true`.
2. THE test module SHALL contain a test named `test_below_direction_crosses_threshold` that sets a mock oracle price below the configured threshold and asserts `check` returns `true`.
3. THE test module SHALL contain a test named `test_price_at_boundary_returns_false` that verifies a price exactly equal to `threshold_e18` returns `false` for both `Above` and `Below`.
4. THE test module SHALL contain a test at the exact staleness boundary: price age equals `max_staleness_seconds` → `check` returns the comparison result; price age equals `max_staleness_seconds + 1` → `check` returns `false`.
5. THE test module SHALL contain a test named `test_missing_price_returns_false` that calls `check` when the mock oracle returns `None` and asserts the result is `false`.
6. THE test module SHALL contain a test named `test_future_dated_price_returns_false` that sets a timestamp greater than the ledger timestamp and asserts `check` returns `false`.
7. THE test module SHALL contain tests for feeds of different decimal precisions (`oracle_decimals = 7`, `oracle_decimals = 18`, and `oracle_decimals > 18`), verifying that normalization produces the correct `price_e18` or returns `false` when decimals exceed 18.
8. THE test module SHALL contain a test that calls any entry point on an uninitialized contract and asserts `ConditionError::NotInitialized` is returned.
9. THE test module SHALL contain a test that calls `initialize` twice and asserts the second call returns `ConditionError::AlreadyInitialized`.
