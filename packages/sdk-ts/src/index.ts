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
export type { IntegerInput } from "./core/scval.js";
export { fromUnixSeconds, toUnixSeconds, type TimestampInput } from "./core/time.js";

export {
  KeeperContractError,
  KeeperErrorCode,
  KeeperRpcError,
  KeeperSdkError,
  decodeKeeperErrorCode,
  isKeeperError,
} from "./errors.js";

export { extendDeadline, type ExtendDeadlineParams } from "./methods/extendDeadline.js";
