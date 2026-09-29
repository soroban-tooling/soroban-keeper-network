/**
 * Profitability calculation module for keeper-bot-v2
 *
 * Implements the profitability check from issue #0254, which estimates
 * the net profit a keeper would receive from executing a task,
 * accounting for all associated costs (claim, execute, verifier simulation).
 *
 * The profitability calculation determines:
 * - Whether a task is worth claiming
 * - The ranking key for candidate prioritization
 */

import type { EvaluatedCandidate, ProfitabilityResult } from "./types.js";

/**
 * Standard baseline gas estimation constants (in stroops).
 * 1 XLM = 10_000_000 stroops. BASE_FEE = 100 stroops.
 *
 * These are conservative estimates used when simulation is not available.
 * In v2, we aim to replace hardcoded guesses with real simulation data.
 */
const DEFAULT_ESTIMATED_CLAIM_FEE_STROOPS = 10_000n;
const DEFAULT_ESTIMATED_EXECUTE_BASE_FEE_STROOPS = 50_000n;
const DEFAULT_ESTIMATED_VERIFIER_FEE_STROOPS = 50_000n;

/**
 * Profitability configuration
 */
export interface ProfitabilityConfig {
  minProfitMarginStroops: bigint;
  estimatedClaimFeeStroops?: bigint;
  estimatedExecuteBaseFeeStroops?: bigint;
  estimatedVerifierFeeStroops?: bigint;
}

/**
 * Estimate the profitability of executing a candidate task.
 *
 * This calculation includes:
 * - Estimated claim_task submission cost
 * - Estimated execute_task submission cost
 * - Estimated verifier simulation cost (if task has a verifier)
 *
 * The net profit is: reward - (claim fee + execute fee + verifier fee)
 *
 * A task is considered profitable if its net profit meets or exceeds
 * the configured minimum profit margin.
 *
 * @param candidate - The evaluated candidate task
 * @param config - Profitability configuration
 * @returns Profitability evaluation result
 */
export function estimateTaskProfitability(
  candidate: EvaluatedCandidate,
  config: ProfitabilityConfig
): ProfitabilityResult {
  const {
    minProfitMarginStroops,
    estimatedClaimFeeStroops = DEFAULT_ESTIMATED_CLAIM_FEE_STROOPS,
    estimatedExecuteBaseFeeStroops = DEFAULT_ESTIMATED_EXECUTE_BASE_FEE_STROOPS,
    estimatedVerifierFeeStroops = DEFAULT_ESTIMATED_VERIFIER_FEE_STROOPS,
  } = config;

  // Calculate total estimated fees
  let estimatedVerifierFee = 0n;
  if (candidate.verifier) {
    estimatedVerifierFee = estimatedVerifierFeeStroops;
  }

  const totalEstimatedFees =
    estimatedClaimFeeStroops +
    estimatedExecuteBaseFeeStroops +
    estimatedVerifierFee;

  const netProfit = candidate.reward - totalEstimatedFees;
  const profitable = netProfit >= minProfitMarginStroops;

  if (!profitable) {
    return {
      profitable: false,
      estimatedFee: totalEstimatedFees,
      netProfit,
      reason: `net profit (${netProfit.toString()} stroops) below minimum margin (${minProfitMarginStroops.toString()} stroops; estimated gas: ${totalEstimatedFees.toString()} stroops, reward: ${candidate.reward.toString()} stroops)`,
    };
  }

  return {
    profitable: true,
    estimatedFee: totalEstimatedFees,
    netProfit,
  };
}

/**
 * Batch-evaluate profitability for multiple candidates.
 *
 * This is more efficient than calling estimateTaskProfitability
 * repeatedly when evaluating a large set of candidates.
 *
 * @param candidates - Array of evaluated candidates
 * @param config - Profitability configuration
 * @returns Array of profitability results in the same order
 */
export function estimateCandidatesProfitability(
  candidates: EvaluatedCandidate[],
  config: ProfitabilityConfig
): ProfitabilityResult[] {
  return candidates.map((candidate) => estimateTaskProfitability(candidate, config));
}

/**
 * Calculate the expected net profit for a candidate (the ranking key).
 *
 * This is the core value used for sorting candidates in descending order
 * before processing. Tasks with higher expected net profit are attempted first.
 *
 * @param candidate - The evaluated candidate task
 * @param config - Profitability configuration
 * @returns The expected net profit (may be negative if unprofitable)
 */
export function getExpectedNetProfit(
  candidate: EvaluatedCandidate,
  config: ProfitabilityConfig
): bigint {
  const result = estimateTaskProfitability(candidate, config);
  return result.netProfit;
}

/**
 * Check if a candidate is profitable according to the configuration.
 *
 * @param candidate - The evaluated candidate task
 * @param config - Profitability configuration
 * @returns true if the candidate's net profit meets the minimum margin
 */
export function isProfitable(
  candidate: EvaluatedCandidate,
  config: ProfitabilityConfig
): boolean {
  const result = estimateTaskProfitability(candidate, config);
  return result.profitable;
}
