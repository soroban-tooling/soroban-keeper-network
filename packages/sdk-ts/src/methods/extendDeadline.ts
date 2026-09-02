/**
 * `extend_deadline` -- the task owner pushes a task's deadline out so keepers
 * have more time to pick it up.
 */

import type { ContractCaller, SignedCallOptions } from "../core/caller.js";
import type { IntegerInput } from "../core/scval.js";
import { addressArg, u64Arg } from "../core/scval.js";
import type { TimestampInput } from "../core/time.js";
import { toUnixSeconds } from "../core/time.js";

export interface ExtendDeadlineParams extends SignedCallOptions {
  /** `G...` address that registered the task. Must authorize the call. */
  owner: string;
  /** Id of the task to extend. */
  taskId: IntegerInput;
  /**
   * The new deadline, as a `Date` or raw Unix seconds -- see the SDK's
   * timestamp convention in `src/core/time.ts`.
   *
   * The contract requires it to be strictly later than the task's current
   * deadline and rejects anything else with `DeadlinePassed`. That comparison
   * needs the task's stored deadline, which this wrapper deliberately does not
   * fetch: an extra read would double the call's cost to pre-empt an error the
   * simulation already reports for free, and the value could change between the
   * read and the call anyway.
   */
  newDeadline: TimestampInput;
}

/**
 * Extends an unfinished task's deadline.
 *
 * Rejects with a `KeeperContractError` carrying, among others:
 * - `NotTaskOwner` when `owner` did not register the task,
 * - `InvalidTaskStatus` when the task is already executed, cancelled, or
 *   expired,
 * - `DeadlinePassed` when `newDeadline` is not later than the current one,
 * - `ContractPaused` while the registry is paused.
 */
export async function extendDeadline(
  caller: ContractCaller,
  params: ExtendDeadlineParams,
): Promise<void> {
  const { owner, taskId, newDeadline, signer } = params;

  await caller.invoke<void>({
    method: "extend_deadline",
    source: owner,
    args: [
      addressArg(owner, "owner"),
      u64Arg(taskId, "taskId"),
      u64Arg(toUnixSeconds(newDeadline, "newDeadline"), "newDeadline"),
    ],
    ...(signer ? { signer } : {}),
  });
}
