# Contract Migrations Guide

This guide documents what changed between `KeeperRegistry` contract `VERSION` releases, what integrators must update when upgrading, and which SDK versions are compatible with each contract version.

The contract exposes its current version via the read-only `version() -> u32` view, backed by `VERSION` in `contracts/keeper-registry/src/constants.rs`.

## Per-Version Migration Table

| `VERSION` | Release Focus | Breaking Changes | Additive Changes | Required Integrator Action |
|---|---|---|---|---|
| **1** | MVP lifecycle | Initial ABI (`register_task`, `claim_task`, `execute_task`, `cancel_task`, `expire_task`, `withdraw_rewards`, admin controls, views) | — | Baseline integration. |
| **2** | Calldata size bound | `register_task` rejects `calldata.len() > MAX_CALLDATA_LEN` (1024 bytes) with new error `CalldataTooLarge`. | None. Empty `calldata` remains valid. | Ensure encoded `calldata` is `<= 1024` bytes; handle `CalldataTooLarge` in client error mappings. |
| **3** | Batch task registration | Error enum ABI extended with `BatchTooLarge` (21), `EmptyBatch` (22), and `BatchRewardCeilingExceeded` (23). | Added `batch_register_tasks(owner, tasks, max_total_reward)`, `max_batch_size()`, `BatchTaskParams`, and bounded batch reads `get_tasks` / `get_tasks_range` (`MAX_BATCH_READ = 50`). | Update error enum decoders for variants 21–23. Callers adopting batch registration should query `max_batch_size()` rather than hardcoding `50` and set `max_total_reward` to the exact sum of batch rewards. |
| **4** | Optional on-chain proof verifier | **Breaking ABI change:** `register_task` adds required parameter `verifier: Option<Address>`. Adds `VerificationFailed` (24) error. | Added `IKeeperVerifier::verify` callback in `execute_task`, `VerifierAttached` (`("vattach", "task")`), `VerifierUpdated` (`("vupdate", "task")`), and `TaskVerificationFailed` (`("verfail", "task")`) events. | **Update every `register_task` call site** to pass `verifier` (`None` for previous behavior, `Some(addr)` to gate execution). Update error decoders for `VerificationFailed` and event consumers for verifier events. |
| **5** | Staking, slashing, and execution dispute window | None to existing signatures (additive ABI). Adds staking and dispute error variants (`InsufficientStake`, `UnbondNotReady`, `UnbondAlreadyPending`, `NoPendingUnbond`, `MinStakeNotMet`, `SlashNotFound`, `AppealWindowClosed`, `AppealAlreadyRaised`, `NotSlashedKeeper`, `NoPendingCredit`, `ExecutionAlreadyDisputed`, `DisputeWindowClosed`, `NoDisputedCredit`). | Added `stake_deposit`, `initiate_unbond`, `withdraw_stake`, `slash`, `set_min_stake`, `raise_slash_appeal`, `resolve_slash_appeal`, `set_dispute_window`, `dispute_execution`, `resolve_execution_dispute`, plus views (`keeper_stake`, `pending_unbond`, `min_stake`, `get_slash`, `dispute_window`, `pending_reward`) and corresponding events. | No signature changes required for existing task callers. Keepers must handle `MinStakeNotMet` if an admin enables `min_stake > 0`, and check `pending_reward` / `dispute_window` if the admin enables an execution dispute window. Update event indexers for staking and dispute events. |
| **6** | On-chain task conditions | **Breaking ABI change:** `register_task` adds required parameter `condition: Option<Address>`. `BatchTaskParams` adds `verifier: Option<Address>` and `condition: Option<Address>`. `Task` struct adds `condition: Option<Address>`. `TaskRegistered` event payload expands from 4 fields to 5 fields `(task_id, owner, reward, deadline, condition)`. | `claim_task` evaluates `ITaskCondition::is_met(task_id)` before claiming, rejecting with `ConditionNotMet` and emitting `("condfail", "task")`. | **Update every `register_task` call site** to pass `condition` (`None` for unconditional tasks). **Update every `BatchTaskParams` construction** to include `verifier` and `condition`. Update event indexers to decode the 5-field `TaskRegistered` payload (retaining 4-field fallback for historical events) and `ConditionNotMet`. |

### Companion Contracts

- **`keeper-treasury`** (`contracts/treasury`): Independent `VERSION = 1`. Registry `sweep_fees` did not change; fees are routed by passing the treasury contract address to `sweep_fees`.
- **`keeper-governance`** (`contracts/governance`): Independent `VERSION` and proposal lifecycle; interacts with `KeeperRegistry` as its `admin` after `transfer_admin`.

## SDK Version Compatibility

Both SDKs use **semver-independent versioning** with explicit compatibility declarations rather than locking SDK major versions to contract `VERSION`.

| Contract `VERSION` | Rust SDK (`soroban-keeper-sdk`) | TypeScript SDK (`@soroban-keeper-network/sdk`) | Notes |
|---|---|---|---|
| **1** | `0.1.0` (`SUPPORTED_CONTRACT_VERSIONS = 1..=6`) | Not in `COMPATIBLE_CONTRACT_VERSIONS` (`[3]`) | Rust SDK accepts `1..=6`; TS SDK `0.1.0` warns on versions other than `3`. |
| **2** | `0.1.0` (`1..=6`) | Not in `COMPATIBLE_CONTRACT_VERSIONS` (`[3]`) | Rust SDK supports `CalldataTooLarge`. |
| **3** | `0.1.0` (`1..=6`) | `0.1.0` (`COMPATIBLE_CONTRACT_VERSIONS = [3]`) | Both SDKs declare compatibility with `VERSION 3`. |
| **4** | `0.1.0` (`1..=6`) | Requires SDK update (`> 0.1.0`) | Breaking `register_task` `verifier` argument; TS SDK `0.1.0` targets `VERSION 3`. |
| **5** | `0.1.0` (`1..=6`) | Requires SDK update (`> 0.1.0`) | Rust SDK `0.1.0` includes full staking and dispute-window wrappers (`rust-sdk/tests/staking.rs`). |
| **6** | `0.1.0` (`1..=6`) | Requires SDK update (`> 0.1.0`) | Rust SDK `0.1.0` (`KeeperRegistryCrossContract::register_task` and `KeeperClient`) updated for `condition: Option<Address>`. |

## Checking Contract Version at Runtime

Integrators should query `version()` on startup and fail fast or warn if the deployed contract is outside their expected range:

- **Rust SDK** (`rust-sdk/VERSIONING.md`): Compare `client.version()` against `soroban_keeper_sdk::SUPPORTED_CONTRACT_VERSIONS` (`1..=6`).
- **TypeScript SDK** (`packages/sdk-ts/VERSIONING.md`): Call `client.version()` and pass the result to `checkContractCompatibility(version)` and `compatibilityWarning(result)`.

## Upgrade Checklist for Integrators

1. Read `version()` on the target deployment before and after a contract `upgrade`.
2. Verify all `register_task` and `batch_register_tasks` call sites match the target `VERSION` ABI (especially when crossing `VERSION 3 -> 4` or `5 -> 6`).
3. Update error enum decoders and event parsers (especially `TaskRegistered`'s 4-field vs 5-field payload at `VERSION 6`).
4. Run integration tests against a testnet deployment or `soroban-sdk` test environment before pointing production bots or dApps at the upgraded contract.
