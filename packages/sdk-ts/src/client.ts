// The core of the SDK: a typed client wrapping the repetitive
// simulate-build-sign-submit dance the keeper-bot example currently
// hand-rolls. See backlog 0153.

import { StrKey } from "@stellar/stellar-sdk";

import { ContractInvoker } from "./core/contractInvoker";
import { decodeKeeperError, KeeperContractError, TaskNotFoundError } from "./errors";
import { getTask } from "./methods/views";
import { buildFeeBumpTransaction, buildTransaction, submitSignedTransaction } from "./transactionBuilder";
import type { KeeperRegistryClientConfig, Task } from "./types";

/**
 * Typed client for the keeper-registry contract. Constructor validates its
 * inputs so a malformed contract address or network passphrase fails fast
 * with a clear error, rather than surfacing as an opaque RPC failure later.
 *
 * ```ts
 * const client = new KeeperRegistryClient({ contractId, rpcUrl, networkPassphrase });
 * const task = await client.getTask(taskId);
 * ```
 */
export class KeeperRegistryClient {
  readonly config: KeeperRegistryClientConfig;
  /** @internal exposed for `methods/*` and `transactionBuilder.ts`, not part of the public API. */
  readonly invoker: ContractInvoker;

  constructor(config: KeeperRegistryClientConfig) {
    if (!StrKey.isValidContract(config.contractId)) {
      throw new Error(`KeeperRegistryClient: "${config.contractId}" is not a valid Soroban contract address (expected a "C..." StrKey).`);
    }
    if (!config.rpcUrl || !/^https?:\/\//.test(config.rpcUrl)) {
      throw new Error(`KeeperRegistryClient: "${config.rpcUrl}" is not a valid RPC URL.`);
    }
    if (!config.networkPassphrase) {
      throw new Error("KeeperRegistryClient: networkPassphrase is required.");
    }

    this.config = config;
    this.invoker = new ContractInvoker(config);
  }

  /**
   * `getTask` on a nonexistent id rejects with {@link TaskNotFoundError}
   * rather than returning a nullish value, so a caller cannot mistake
   * "task does not exist" for "task exists and every field happens to be
   * falsy."
   */
  async getTask(taskId: number, sourcePublicKey?: string): Promise<Task> {
    try {
      return await getTask(this.invoker, taskId, this.config.readOnlySourceAccount, sourcePublicKey);
    } catch (err) {
      const code = decodeKeeperError(err instanceof Error ? err.message : undefined);
      if (code !== undefined) {
        if (code === 4 /* TaskNotFound, see errors.ts KeeperErrorCode */) {
          throw new TaskNotFoundError(taskId);
        }
        throw new KeeperContractError(code);
      }
      throw err;
    }
  }

  buildTransaction = buildTransaction.bind(null, this);
  buildFeeBumpTransaction = buildFeeBumpTransaction.bind(null, this);
  submitSignedTransaction = submitSignedTransaction.bind(null, this);
}
