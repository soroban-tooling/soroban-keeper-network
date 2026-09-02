import { KeeperRegistryClient } from "../client";
import { UpdateVerifierParams, BuildTransactionOptions, TransactionResult } from "../types";

/**
 * Updates or clears the attached verifier address for a pending task.
 * Restricted strictly to `Pending` status tasks — attempts against claimed or completed tasks
 * reject with `KeeperErrorCode.InvalidTaskStatus`.
 *
 * @param client The KeeperRegistryClient instance
 * @param params { owner, taskId, verifier? } (verifier: undefined clears the verifier)
 * @param options Building options
 */
export async function updateVerifier(
  client: KeeperRegistryClient,
  params: UpdateVerifierParams,
  options?: BuildTransactionOptions
): Promise<TransactionResult> {
  return client.updateVerifier(params, options);
}
