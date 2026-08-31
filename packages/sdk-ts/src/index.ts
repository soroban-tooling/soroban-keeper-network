// Entry point for @soroban-keeper-network/sdk.
//
/**
 * `@soroban-keeper-network/sdk` -- a typed client for the keeper-registry
 * contract.
 *
 * ```ts
 * import { KeeperRegistryClient, keypairSigner } from "@soroban-keeper-network/sdk";
 *
 * const client = new KeeperRegistryClient({
 *   contractId: process.env.REGISTRY_CONTRACT_ID!,
 *   rpcUrl: "https://soroban-testnet.stellar.org",
 *   networkPassphrase: Networks.TESTNET,
 *   signer: keypairSigner(Keypair.fromSecret(process.env.KEEPER_SECRET_KEY!)),
 * });
 * ```
 */

export {
  KeeperRegistryClient,
  keypairSigner,
  type KeeperRegistryClientOptions,
  type RpcServerLike,
} from "./client.js";

export type {
  ContractCaller,
  SignedCallOptions,
  TransactionSigner,
} from "./core/caller.js";

export { SUPPORTED_CONTRACT_VERSIONS } from "./constants.js";
export type { IntegerInput } from "./core/scval.js";
export { fromUnixSeconds, toUnixSeconds, type TimestampInput } from "./core/time.js";

export { MAX_PROOF_LEN } from "./constants.js";

export {
  KeeperContractError,
  KeeperErrorCode,
  KeeperRpcError,
  KeeperSdkError,
  decodeKeeperErrorCode,
  isKeeperError,
} from "./errors.js";

export {
  admin,
  checkContractCompatibility,
  feesAccrued,
  getFeeBps,
  isPaused,
  minReward,
  rewardTokenAddress,
  version,
  type CompatibilityStatus,
  type ContractCompatibility,
  type VersionOptions,
} from "./methods/views.js";
  tryWithdrawRewards,
  withdrawRewards,
  type WithdrawRewardsParams,
} from "./methods/withdrawRewards.js";
export { extendDeadline, type ExtendDeadlineParams } from "./methods/extendDeadline.js";
export {
  executeTask,
  toProofBytes,
  type ExecuteTaskParams,
  type ProofInput,
} from "./methods/executeTask.js";
// Entry point for @soroban-keeper-network/sdk.
//
// This package began as a scaffold (backlog 0151 / epic E12) and now
// includes the shared client plumbing, typed errors, view methods, and
// transaction-building primitives this epic's issues need. React hooks are
// under the separate `@soroban-keeper-network/sdk/react` entry point (see
// `src/react/index.ts`) so non-React consumers aren't forced to install
// React as a dependency.

/** The SDK's own package version, kept in sync with package.json by hand until a release job automates it (see backlog 0186). */
export const SDK_VERSION = "0.1.0";

export { KeeperRegistryClient } from "./client";
export { decodeKeeperError, KeeperContractError, KeeperErrorCode, TaskNotFoundError } from "./errors";
export {
  buildFeeBumpTransaction,
  buildTransaction,
  submitSignedTransaction,
  type ExternalSigner,
  type UnsignedTransaction,
} from "./transactionBuilder";
export type { KeeperRegistryClientConfig, NetworkPreset, Task } from "./types";
export { TaskStatus, TaskType } from "./types";
// This package is a scaffold (backlog 0151 / epic E12): build tooling,
// TypeScript config, and a placeholder export, proving the ESM/CJS/.d.ts
// build pipeline works end to end. The typed KeeperRegistryClient and its
// per-entry-point methods are filled in by the rest of epic E12's issues.

/** The SDK's own package version, kept in sync with package.json by hand until a release job automates it (see backlog 0186). */
export const SDK_VERSION = "0.1.0";
export { KeeperRegistryClient } from "./client.js";
export type { KeeperRegistryClientOptions } from "./client.js";
export {
  NETWORK_PRESETS,
  NETWORK_NAMES,
  isNetworkName,
} from "./network.js";
export type { NetworkName, NetworkPreset } from "./network.js";
export { withRetry } from "./retry.js";
export type { RetryOptions } from "./retry.js";
export {
  KeeperErrorCode,
  decodeKeeperError,
  isKeeperError,
} from "./errors.js";
export type { DecodedKeeperError } from "./errors.js";
export {
  SDK_VERSION,
  COMPATIBLE_CONTRACT_VERSIONS,
  checkContractCompatibility,
  compatibilityWarning,
} from "./version.js";
export type { CompatibilityResult } from "./version.js";
