/**
 * `@soroban-keeper-network/sdk/treasury` -- a typed client for the treasury
 * contract (`contracts/treasury`), separate from the `KeeperRegistryClient`
 * exported from the package root since the two are distinct deployed
 * contracts.
 *
 * ```ts
 * import { TreasuryClient, keypairSigner } from "@soroban-keeper-network/sdk/treasury";
 *
 * const treasury = new TreasuryClient({
 *   contractId: process.env.TREASURY_CONTRACT_ID!,
 *   rpcUrl: "https://soroban-testnet.stellar.org",
 *   networkPassphrase: Networks.TESTNET,
 *   signer: keypairSigner(Keypair.fromSecret(process.env.ADMIN_SECRET_KEY!)),
 * });
 * ```
 */

export {
  TreasuryClient,
  keypairSigner,
  type AddRecipientParams,
  type AdminCallParams,
  type DistributeParams,
  type InitializeParams,
  type RemoveRecipientParams,
  type RpcServerLike,
  type SignedCallOptions,
  type TransactionSigner,
  type TransferAdminParams,
  type TreasuryClientOptions,
  type UpdateRecipientSharesParams,
  type UpgradeParams,
  type WithdrawParams,
} from "./client.js";

export {
  TreasuryContractError,
  TreasuryErrorCode,
  TreasuryRpcError,
  TreasurySdkError,
  decodeTreasuryErrorCode,
  isTreasuryError,
  toTreasuryError,
} from "./errors.js";

export type { IntegerInput } from "./scval.js";
export type { Recipient, TreasuryClientConfig } from "./types.js";

export {
  keypairAuthSigner,
  signAuthEntries,
  type AuthEntrySigner,
} from "../core/auth.js";
