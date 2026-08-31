/**
 * `withdraw_rewards` -- a keeper pulls its accrued balance out of the registry.
 */

import type { ContractCaller, SignedCallOptions } from "../core/caller.js";
import { addressArg } from "../core/scval.js";
import { KeeperErrorCode, isKeeperError } from "../errors.js";

export interface WithdrawRewardsParams extends SignedCallOptions {
  /** `G...` address of the keeper withdrawing. Must authorize the call. */
  keeper: string;
}

/**
 * Withdraws the keeper's full accrued balance and returns the amount moved.
 *
 * The return type is `bigint` because the contract returns `i128`, which can
 * exceed `Number.MAX_SAFE_INTEGER`; this follows the SDK-wide numeric
 * convention (backlog issue 0165) and matches what `scValToNative` already
 * produces for `i128`. The value is in the reward token's own units -- stroops
 * for XLM.
 *
 * Rejects with a `KeeperContractError` whose `code` is
 * `KeeperErrorCode.NoRewardsAvailable` when the balance is zero. That is an
 * expected outcome for a bot that withdraws on a timer rather than on a
 * balance check, so callers can branch on it without matching error text --
 * see {@link tryWithdrawRewards} for the ready-made version.
 */
export async function withdrawRewards(
  caller: ContractCaller,
  params: WithdrawRewardsParams,
): Promise<bigint> {
  const { keeper, signer } = params;

  const withdrawn = await caller.invoke<bigint>({
    method: "withdraw_rewards",
    source: keeper,
    args: [addressArg(keeper, "keeper")],
    ...(signer ? { signer } : {}),
  });

  // The contract always returns the amount on success. A missing return value
  // means the SDK is talking to something that is not this contract's ABI, and
  // reporting 0n there would look exactly like a successful empty withdrawal.
  if (typeof withdrawn !== "bigint") {
    throw new TypeError(
      `withdraw_rewards returned ${String(withdrawn)} instead of an i128 amount; the deployed contract may not be a keeper-registry.`,
    );
  }
  return withdrawn;
}

/**
 * {@link withdrawRewards}, with the empty-balance case folded into the return
 * value: resolves to `0n` instead of rejecting when there is nothing to
 * withdraw.
 *
 * A keeper bot polling on a timer hits `NoRewardsAvailable` as its normal
 * steady state, not as an incident, and should not have to wrap every call in a
 * try/catch just to keep that out of its error log. Every other contract
 * rejection still propagates.
 */
export async function tryWithdrawRewards(
  caller: ContractCaller,
  params: WithdrawRewardsParams,
): Promise<bigint> {
  try {
    return await withdrawRewards(caller, params);
  } catch (error) {
    if (isKeeperError(error, KeeperErrorCode.NoRewardsAvailable)) return 0n;
    throw error;
  }
}
