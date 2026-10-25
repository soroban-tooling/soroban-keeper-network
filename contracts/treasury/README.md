# Soroban Keeper Network — Treasury Contract

Standalone Soroban contract responsible for receiving swept protocol fees from the Keeper Registry and distributing them pro-rata across configured recipients.

## Architecture & Layout

The treasury contract follows the established module layout, admin/pause/upgrade patterns, and Checks-Effects-Interactions (CEI) discipline as `contracts/keeper-registry`:

- `src/lib.rs` — Contract entry points, top-level exports, and storage layout specification.
- `src/admin.rs` — Admin operations: initialization, pause/unpause, admin transfer, and wasm upgrade.
- `src/distribution.rs` — Core distribution logic (`distribute`) and recipient withdrawals (`withdraw`).
- `src/views.rs` — Free read-only views (side-effect-free, never bump TTL on uninitialized states).
- `src/constants.rs` — Bounds and version constants (`VERSION`, `MAX_RECIPIENTS`, `MAX_SHARES_BPS`).
- `src/events.rs` — Structured event emission for auditability and indexer ingestion.
- `src/types.rs` — Storage keys (`DataKey`) and data structures (`Recipient`).

## Versioning Convention

The contract implements the `version(&Env) -> u32` read-only view method matching the `keeper-registry` convention:
- Current version is exposed as `VERSION = 1`.
- Off-chain clients (TypeScript SDK, Rust SDK) and the indexer query `version()` to negotiate compatible ABIs.

## Building

Build the contract WASM bundle using:

```bash
cargo build --target wasm32-unknown-unknown --release -p keeper-treasury
```

The resulting WASM artifact is placed in:
`target/wasm32-unknown-unknown/release/keeper_treasury.wasm`

## Local Deployment & Testing

In unit and integration tests, the contract is deployed using the standard Soroban test environment:

```rust
let env = Env::default();
let treasury_id = env.register(Treasury, ());
let client = TreasuryClient::new(&env, &treasury_id);

// Check version
assert_eq!(client.version(), 1);

// Initialize with admin and token
client.initialize(&admin, &reward_token);
```
