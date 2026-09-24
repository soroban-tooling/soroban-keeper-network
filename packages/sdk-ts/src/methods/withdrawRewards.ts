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
 * The outcome of a withdraw attempt.
 *
 * - `{ status: "withdrawn", amount: bigint }` means the withdrawal succeeded
 *   and the amount shown was moved. The transaction is submitted.
 * - `{ status: "no_rewards_available", amount: 0n }` means the balance was
 *   zero. This is determined during a free pre-submission balance check
 *   without spending a fee on a doomed transaction.
 *
 * Every other failure (authorization errors, contract paused, etc.) still
 * rejects as a thrown error.
 */
export type WithdrawRewardsOutcome =
  | { status: "withdrawn"; amount: bigint }
  | { status: "no_rewards_available"; amount: 0n };

/**
 * Checks the keeper's current balance and withdraws it if non-zero.
 *
 * Unlike the earlier {@link withdrawRewards} function, this uses a
 * pre-submission check to avoid spending a fee when there are no rewards to
 * collect. It first reads the keeper's balance (free) and only submits a
 * transaction if the balance is non-zero.
 *
 * This follows the same pattern as issue #0034's pre-check for claim_task:
 * filtering out doomed transactions before submission saves fees in the
 * common case where a keeper has accumulated no rewards.
 *
 * The return type is `bigint` because the contract returns `i128`, which can
 * exceed `Number.MAX_SAFE_INTEGER`; this follows the SDK-wide numeric
 * convention (backlog issue 0165) and matches what `scValToNative` already
 * produces for `i128`. The value is in the reward token's own units -- stroops
 * for XLM.
 *
 * @returns the withdrawal outcome. If successful, the amount is provided; if
 *   no balance was available, a zero-balance outcome is returned without
 *   submitting a transaction or spending a fee.
 */
export async function withdrawRewards(
  caller: ContractCaller,
  params: WithdrawRewardsParams,
): Promise<WithdrawRewardsOutcome> {
  const { keeper, signer } = params;

  // Pre-check: read the balance (free, no submission).
  // If zero, return early without submitting a fee-paying transaction.
  let balance: bigint;
  try {
    balance = await caller.read<bigint>("keeper_balance", [addressArg(keeper, "keeper")]);
  } catch (error) {
    // A read failure is unexpected and should propagate.
    throw error;
  }

  if (typeof balance !== "bigint") {
    // Type safety check: the contract should always return an i128.
    throw new TypeError(
      `keeper_balance returned ${String(balance)} instead of an i128; the deployed contract may not be a keeper-registry.`,
    );
  }

  if (balance === 0n) {
    // No balance; skip the submission.
    return { status: "no_rewards_available", amount: 0n };
  }

  // Balance is non-zero; proceed to submission.
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

  return { status: "withdrawn", amount: withdrawn };
}

/**
 * {@link withdrawRewards}, now that it performs a pre-check, is the recommended
 * function and this wrapper exists only for backward compatibility.
 *
 * **Deprecated:** Use {@link withdrawRewards} instead. It now returns an
 * outcome type and performs the zero-balance check before submission, making
 * this wrapper unnecessary.
 *
 * A keeper bot polling on a timer hits `NoRewardsAvailable` as its normal
 * steady state, not as an incident, and should not have to wrap every call in a
 * try/catch just to keep that out of its error log. Every other contract
 * rejection still propagates.
 *
 * @deprecated Use {@link withdrawRewards} instead.
 */
export async function tryWithdrawRewards(
  caller: ContractCaller,
  params: WithdrawRewardsParams,
): Promise<bigint> {
  const outcome = await withdrawRewards(caller, params);
  return outcome.amount;
}
