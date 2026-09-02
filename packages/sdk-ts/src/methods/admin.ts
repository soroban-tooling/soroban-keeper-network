/**
 * The single-auth admin controls: one admin signature, one stored value
 * changes. `pause`/`unpause` are the emergency circuit breaker, `set_fee_bps`
 * and `set_min_reward` the two tunable policy knobs.
 *
 * The dual-auth admin methods (`transfer_admin`, `sweep_fees`) need a second
 * signature and live separately -- see backlog 0155.
 */

import type { ContractCaller, SignedCallOptions } from "../core/caller.js";
import type { IntegerInput } from "../core/scval.js";
import { addressArg, i128Arg, u32Arg } from "../core/scval.js";
import { KeeperContractError, KeeperErrorCode } from "../errors.js";

/** Shared by every entry point here: the admin authorizes, and is the source. */
export interface AdminCallParams extends SignedCallOptions {
  /** `G...` address stored as the registry's admin. Must authorize the call. */
  admin: string;
}

export interface SetFeeBpsParams extends AdminCallParams {
  /** New protocol fee in basis points, `0`..`10_000` inclusive. */
  newBps: number;
}

export interface SetMinRewardParams extends AdminCallParams {
  /** New reward floor in the reward token's own units. `i128`, so `bigint`. */
  minReward: IntegerInput;
}

/** The contract's own ceiling on `set_fee_bps`: 10,000 bps == 100%. */
const MAX_FEE_BPS = 10_000;

/**
 * Distinguishes "you are not the admin" from "there is no admin yet".
 *
 * The contract's `require_admin` returns `Unauthorized` for both -- a wrong
 * caller and a registry that was never initialized collapse into the same
 * discriminant (see `contracts/keeper-registry/src/lib.rs`). One cheap `admin`
 * simulation, which costs nothing and needs no signer, tells them apart, so a
 * caller who simply pointed the SDK at an undeployed-into registry gets
 * `NotInitialized` instead of being told their key is wrong.
 *
 * This is a diagnostic, not a security check: the contract still enforces
 * authorization itself, and a registry initialized between this read and the
 * call below just falls through to the contract's own verdict.
 */
async function requireInitialized(caller: ContractCaller, method: string): Promise<void> {
  const currentAdmin = await caller.read<string | undefined>("admin");
  if (currentAdmin === undefined || currentAdmin === null) {
    throw new KeeperContractError(
      KeeperErrorCode.NotInitialized,
      `${method} requires an initialized registry, but no admin is configured. Call initialize first.`,
      { local: true },
    );
  }
}

/** Pauses the registry: blocks register, claim, and execute until unpaused. */
export async function pause(caller: ContractCaller, params: AdminCallParams): Promise<void> {
  await adminCall(caller, "pause", params, []);
}

/** Lifts a pause set by {@link pause}. */
export async function unpause(caller: ContractCaller, params: AdminCallParams): Promise<void> {
  await adminCall(caller, "unpause", params, []);
}

/**
 * Sets the protocol fee withheld from each executed task's reward.
 *
 * `newBps` is checked against the contract's own 10,000 bound locally, before
 * any network call: the contract rejects the same values with `InvalidFeeBps`,
 * and there is no reason to pay a simulation round trip for a value that can
 * never succeed. Exactly 10,000 is legal and goes to the network; 10,001 does
 * not. The rejection carries the same code the contract would have returned,
 * with `local` set, so a caller branching on `KeeperErrorCode.InvalidFeeBps`
 * handles both paths identically.
 */
export async function setFeeBps(caller: ContractCaller, params: SetFeeBpsParams): Promise<void> {
  const { newBps } = params;
  if (!Number.isInteger(newBps) || newBps < 0 || newBps > MAX_FEE_BPS) {
    throw new KeeperContractError(
      KeeperErrorCode.InvalidFeeBps,
      `newBps must be a whole number of basis points between 0 and ${MAX_FEE_BPS}, got ${newBps}.`,
      { local: true },
    );
  }
  await adminCall(caller, "set_fee_bps", params, [u32Arg(newBps, "newBps")]);
}

/**
 * Sets the smallest reward a task may be registered with.
 *
 * Applies to future registrations only; tasks already on-chain keep whatever
 * reward they were registered with.
 */
export async function setMinReward(
  caller: ContractCaller,
  params: SetMinRewardParams,
): Promise<void> {
  await adminCall(caller, "set_min_reward", params, [i128Arg(params.minReward, "minReward")]);
}

/**
 * The shape every entry point above shares: check the registry is initialized,
 * then invoke with the admin as both the authorizing address and the source.
 */
async function adminCall(
  caller: ContractCaller,
  method: string,
  { admin, signer }: AdminCallParams,
  extraArgs: ReturnType<typeof addressArg>[],
): Promise<void> {
  // Encode before the read so a malformed address fails without a round trip.
  const adminArg = addressArg(admin, "admin");
  await requireInitialized(caller, method);
  await caller.invoke<void>({
    method,
    source: admin,
    args: [adminArg, ...extraArgs],
    ...(signer ? { signer } : {}),
  });
}
