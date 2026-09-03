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
  getTask,
  isClaimable,
  isPaused,
  keeperBalance,
  minReward,
  rewardTokenAddress,
  taskCount,
  version,
  type CompatibilityStatus,
  type ContractCompatibility,
  type VersionOptions,
} from "./methods/views.js";

export {
  sweepFees,
  transferAdmin,
  upgrade,
  type SweepFeesParams,
  type TransferAdminParams,
  type UpgradeParams,
} from "./methods/adminDualAuth.js";

export {
  keypairAuthSigner,
  signAuthEntries,
  type AuthEntrySigner,
} from "./core/auth.js";

export {
  pause,
  setFeeBps,
  setMinReward,
  unpause,
  type AdminCallParams,
  type SetFeeBpsParams,
  type SetMinRewardParams,
} from "./methods/admin.js";

export {
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
export { registerTask, type RegisterTaskParams } from "./methods/registerTask.js";
export { increaseReward, type IncreaseRewardParams } from "./methods/increaseReward.js";
export {
  claimTask,
  type ClaimTaskOutcome,
  type ClaimTaskParams,
} from "./methods/claimTask.js";
export {
  cancelTask,
  type CancelTaskOutcome,
  type CancelTaskParams,
} from "./methods/cancelTask.js";
export { expireTask, type ExpireTaskParams } from "./methods/expireTask.js";
export {
  MAX_CALLDATA_LEN,
  MAX_LOCK_LEDGERS,
  MIN_LOCK_LEDGERS,
  MIN_TTL_LEDGERS,
} from "./constants.js";

/** The SDK's own package version, kept in sync with package.json by hand until a release job automates it (see backlog 0186). */
export const SDK_VERSION = "0.1.0";

export { decodeKeeperError, TaskNotFoundError } from "./errors.js";
export {
  buildFeeBumpTransaction,
  buildTransaction,
  submitSignedTransaction,
  type ExternalSigner,
  type UnsignedTransaction,
} from "./transactionBuilder.js";
export { TaskStatus, TaskType, type Task } from "./types.js";
export {
  NETWORK_PRESETS,
  NETWORK_NAMES,
  isNetworkName,
} from "./network.js";
export type { NetworkName, NetworkPreset } from "./network.js";
export { withRetry } from "./retry.js";
export type { RetryOptions } from "./retry.js";
