/**
 * `increase_reward` -- the owner tops up the bounty on a task that has not
 * finished yet, to attract keepers. The extra amount is escrowed immediately.
 *
 * Mirrors `contracts/keeper-registry/src/task.rs::increase_reward`.
 */

import type { ContractCaller, SignedCallOptions } from "../core/caller.js";
import type { IntegerInput } from "../core/scval.js";
import { addressArg, i128Arg, toBigInt, u64Arg } from "../core/scval.js";
import { KeeperContractError, KeeperErrorCode } from "../errors.js";

export interface IncreaseRewardParams extends SignedCallOptions {
  /** `G...` address that registered the task. Must authorize the call. */
  owner: string;
  /** Id of the task to top up. */
  taskId: IntegerInput;
  /** Amount to add to the escrowed reward, in the reward token's own units. */
  additional: IntegerInput;
}

/**
 * Adds `additional` to a task's escrowed reward.
 *
 * Only the owner of a `Pending` or `Claimed` task may do this. A non-positive
 * amount is refused locally with the contract's own `InvalidReward`; the
 * remaining preconditions -- ownership and status -- are left to the contract,
 * because this client cannot know a task's current state without an extra read
 * that would be stale by the time the call landed anyway.
 *
 * Rejects with a `KeeperContractError` carrying, among others:
 * - `InvalidReward` when `additional` is non-positive,
 * - `NotTaskOwner` when the signer did not register the task,
 * - `InvalidTaskStatus` when the task is already executed, cancelled, or expired,
 * - `TaskNotFound` when no task has that id.
 */
export async function increaseReward(
  caller: ContractCaller,
  params: IncreaseRewardParams,
): Promise<void> {
  const { owner, taskId, additional, signer } = params;

  if (toBigInt(additional, "additional") <= 0n) {
    throw new KeeperContractError(
      KeeperErrorCode.InvalidReward,
      `additional must be positive, got ${additional}. No transaction was built.`,
      { local: true },
    );
  }

  await caller.invoke<void>({
    method: "increase_reward",
    source: owner,
    args: [addressArg(owner, "owner"), u64Arg(taskId, "taskId"), i128Arg(additional, "additional")],
    ...(signer ? { signer } : {}),
  });
}
