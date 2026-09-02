/**
 * `register_task` -- the task owner escrows a reward and puts a job on the
 * board for keepers to claim.
 *
 * Mirrors `contracts/keeper-registry/src/task.rs::register_task`.
 */

import {
  MAX_CALLDATA_LEN,
  MAX_LOCK_LEDGERS,
  MIN_LOCK_LEDGERS,
  MIN_TTL_LEDGERS,
} from "../constants.js";
import type { ContractCaller, SignedCallOptions } from "../core/caller.js";
import type { IntegerInput } from "../core/scval.js";
import {
  addressArg,
  bytesArg,
  i128Arg,
  optionalAddressArg,
  toBigInt,
  u32Arg,
  u64Arg,
} from "../core/scval.js";
import type { TimestampInput } from "../core/time.js";
import { toUnixSeconds } from "../core/time.js";
import { KeeperContractError, KeeperErrorCode, KeeperSdkError } from "../errors.js";
import type { TaskType } from "../types.js";

export interface RegisterTaskParams extends SignedCallOptions {
  /** `G...` address funding the task. Must authorize the call. */
  owner: string;
  /**
   * Which kind of automation this task represents.
   *
   * A simple (no-payload) `#[contracttype]` enum is encoded as a plain `u32`
   * on the wire, not as a symbol, so an off-by-one here registers a different
   * kind of task rather than failing. {@link TaskType} mirrors the contract's
   * discriminants exactly for that reason.
   */
  taskType: TaskType;
  /** Encoded parameters a keeper uses to reconstruct the target call. At most {@link MAX_CALLDATA_LEN} bytes. */
  calldata: Uint8Array;
  /** Reward escrowed as the bounty, in the reward token's own units. `i128`, so `bigint`. */
  reward: IntegerInput;
  /** When the task may be expired. See {@link TimestampInput}; must be in the future. */
  deadline: TimestampInput;
  /** Ledgers of storage lifetime for the task entry. At least {@link MIN_TTL_LEDGERS}. */
  ttlLedgers: number;
  /** Ledgers a claiming keeper holds the task exclusively. Within `[MIN_LOCK_LEDGERS, MAX_LOCK_LEDGERS]`. */
  lockLedgers: number;
  /**
   * Optional `C...` verifier contract consulted before a keeper is credited
   * (contract `VERSION` 4, epic E04). Omit it for an unverified task, which is
   * what the contract stores when this argument is `None`.
   */
  verifier?: string;
}

/**
 * Registers a new task, escrowing `reward` from `owner` into the contract.
 *
 * The cheaply-checkable half of the contract's `validate_task_params` runs
 * locally first, so a doomed call costs a thrown error instead of a simulation
 * round trip. That is an optimisation, not a replacement: the contract stays
 * authoritative, and it also enforces a configurable `MinReward` floor this
 * client cannot see without an extra read, so a positive reward can still be
 * rejected on-chain with `InvalidReward`.
 *
 * Rejects with a `KeeperContractError` carrying, among others:
 * - `InvalidReward` when the reward is non-positive or under the floor,
 * - `DeadlinePassed` when the deadline is not in the future,
 * - `CalldataTooLarge` when the calldata exceeds `MAX_CALLDATA_LEN`,
 * - `InvalidTaskParams` / `TtlTooShort` for out-of-range lock and TTL windows,
 * - `ContractPaused` when the registry is paused.
 *
 * `error.local` is `true` on the ones this SDK caught before submitting.
 *
 * @returns the new task's id.
 */
export async function registerTask(
  caller: ContractCaller,
  params: RegisterTaskParams,
): Promise<bigint> {
  const { owner, taskType, calldata, reward, ttlLedgers, lockLedgers, verifier, signer } = params;
  const deadline = toUnixSeconds(params.deadline, "deadline");

  validateRegisterTaskParams(params, deadline);

  const taskId = await caller.invoke<bigint | undefined>({
    method: "register_task",
    source: owner,
    args: [
      addressArg(owner, "owner"),
      u32Arg(taskType, "taskType"),
      bytesArg(calldata),
      i128Arg(reward, "reward"),
      u64Arg(deadline, "deadline"),
      u32Arg(ttlLedgers, "ttlLedgers"),
      u32Arg(lockLedgers, "lockLedgers"),
      optionalAddressArg(verifier, "verifier"),
    ],
    ...(signer ? { signer } : {}),
  });

  if (typeof taskId !== "bigint") {
    // `register_task` always returns the new id, so an absent one means the
    // response did not come from the contract we think it did -- worth saying
    // so rather than handing back a confusing `undefined`.
    throw new KeeperSdkError(
      `register_task returned no task id (got ${String(taskId)}). ` +
        `Check that contractId points at a keeper-registry deployment.`,
    );
  }
  return taskId;
}

/**
 * The locally-checkable half of the contract's `validate_task_params`
 * (`contracts/keeper-registry/src/internal.rs`), reusing the contract's own
 * error codes so a caller branching on {@link KeeperErrorCode} handles the
 * local and the on-chain rejection identically.
 */
function validateRegisterTaskParams(params: RegisterTaskParams, deadline: bigint): void {
  const { calldata, ttlLedgers, lockLedgers } = params;
  const reward = toBigInt(params.reward, "reward");

  if (reward <= 0n) {
    throw new KeeperContractError(
      KeeperErrorCode.InvalidReward,
      `reward must be positive, got ${reward}. No transaction was built.`,
      { local: true },
    );
  }
  if (deadline <= BigInt(Math.floor(Date.now() / 1000))) {
    throw new KeeperContractError(
      KeeperErrorCode.DeadlinePassed,
      `deadline must be in the future, got ${deadline} (Unix seconds). No transaction was built.`,
      { local: true },
    );
  }
  if (calldata.length > MAX_CALLDATA_LEN) {
    throw new KeeperContractError(
      KeeperErrorCode.CalldataTooLarge,
      `calldata is ${calldata.length} bytes, exceeding the contract's MAX_CALLDATA_LEN of ${MAX_CALLDATA_LEN}. No transaction was built.`,
      { local: true },
    );
  }
  if (lockLedgers < MIN_LOCK_LEDGERS || lockLedgers > MAX_LOCK_LEDGERS) {
    throw new KeeperContractError(
      KeeperErrorCode.InvalidTaskParams,
      `lockLedgers must be within [${MIN_LOCK_LEDGERS}, ${MAX_LOCK_LEDGERS}], got ${lockLedgers}. No transaction was built.`,
      { local: true },
    );
  }
  if (ttlLedgers < MIN_TTL_LEDGERS) {
    throw new KeeperContractError(
      KeeperErrorCode.TtlTooShort,
      `ttlLedgers must be at least ${MIN_TTL_LEDGERS}, got ${ttlLedgers}. No transaction was built.`,
      { local: true },
    );
  }
}
