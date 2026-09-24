/**
 * Candidate ranking module for keeper-bot-v2
 *
 * Implements task prioritization by expected net profit (issue #0261).
 * Candidates are ranked in descending order of profitability before processing,
 * ensuring that when a round cannot process every candidate, the most profitable
 * opportunities are attempted first.
 */

import type { EvaluatedCandidate, RankedCandidate } from "./types.js";
import { estimateTaskProfitability, getExpectedNetProfit } from "./profitability.js";
import type { ProfitabilityConfig } from "./profitability.js";

/**
 * Rank candidates by expected net profit in descending order.
 *
 * This function:
 * 1. Evaluates profitability for each candidate
 * 2. Sorts by descending expected net profit
 * 3. Uses task ID as a stable tiebreaker for equivalent profitability
 *
 * The sorting is deterministic: given the same input candidates,
 * the output order is always identical.
 *
 * Time complexity: O(n log n) for the sort, O(n) for profitability evaluation.
 * Space complexity: O(n) for the ranked candidates array.
 *
 * @param candidates - Array of evaluated candidates to rank
 * @param profitabilityConfig - Configuration for profitability calculation
 * @returns Array of ranked candidates sorted by descending net profit,
 *          ready for sequential processing
 */
export function rankCandidatesByProfit(
  candidates: EvaluatedCandidate[],
  profitabilityConfig: ProfitabilityConfig
): RankedCandidate[] {
  // Evaluate profitability and attach ranking information to each candidate
  const rankedCandidates: RankedCandidate[] = candidates.map((candidate) => {
    const profitabilityResult = estimateTaskProfitability(
      candidate,
      profitabilityConfig
    );

    return {
      ...candidate,
      expectedNetProfit: profitabilityResult.netProfit,
      estimatedFee: profitabilityResult.estimatedFee,
      profitable: profitabilityResult.profitable,
    };
  });

  // Sort by descending expected net profit, with task ID as stable tiebreaker
  rankedCandidates.sort((a, b) => {
    // Primary sort: descending net profit (higher profit first)
    const profitDiff = b.expectedNetProfit - a.expectedNetProfit;
    if (profitDiff !== 0n) {
      return profitDiff > 0n ? 1 : -1;
    }

    // Tiebreaker: ascending task ID (stable ordering for equal profit)
    return a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0;
  });

  return rankedCandidates;
}

/**
 * Select the top-N candidates by profitability until a budget limit is reached.
 *
 * This function is used to enforce round capacity constraints:
 * - maxTasksPerRound: process at most N tasks
 * - Candidates are already ranked by profit
 * - We consume candidates in rank order until the budget is exhausted
 *
 * The selection is deterministic: the same ranked list and limit always
 * produce the same result.
 *
 * @param rankedCandidates - Array of candidates pre-ranked by profitability
 * @param maxTasksPerRound - Maximum number of candidates to select
 * @returns Array of selected candidates in rank order, length <= maxTasksPerRound
 */
export function selectTopCandidates(
  rankedCandidates: RankedCandidate[],
  maxTasksPerRound: number
): RankedCandidate[] {
  return rankedCandidates.slice(0, Math.min(maxTasksPerRound, rankedCandidates.length));
}

/**
 * Partition ranked candidates into profitable and unprofitable groups.
 *
 * Used for filtering and logging: distinguishes tasks that should be
 * attempted (profitable) from those that should be skipped (unprofitable).
 *
 * @param rankedCandidates - Array of ranked candidates
 * @returns Object with profitable and unprofitable arrays
 */
export function partitionByProfitability(rankedCandidates: RankedCandidate[]): {
  profitable: RankedCandidate[];
  unprofitable: RankedCandidate[];
} {
  const profitable: RankedCandidate[] = [];
  const unprofitable: RankedCandidate[] = [];

  for (const candidate of rankedCandidates) {
    if (candidate.profitable) {
      profitable.push(candidate);
    } else {
      unprofitable.push(candidate);
    }
  }

  return { profitable, unprofitable };
}

/**
 * Filter ranked candidates to only include profitable ones.
 *
 * A shorthand for partitionByProfitability that returns only profitable candidates.
 *
 * @param rankedCandidates - Array of ranked candidates
 * @returns Array of only profitable candidates, in rank order
 */
export function filterProfitable(rankedCandidates: RankedCandidate[]): RankedCandidate[] {
  return rankedCandidates.filter((c) => c.profitable);
}

/**
 * Calculate statistics about a set of ranked candidates.
 *
 * Useful for logging and observability: provides insight into the
 * profitability distribution and selection decisions.
 *
 * @param rankedCandidates - Array of ranked candidates
 * @param selectedCount - Number of candidates selected for processing
 * @returns Statistics object
 */
export function getCandidateRankingStats(
  rankedCandidates: RankedCandidate[],
  selectedCount: number
): {
  totalCandidates: number;
  totalProfitable: number;
  selectedCount: number;
  topRankProfit: bigint | null;
  bottomRankProfit: bigint | null;
  averageProfit: bigint;
  deferred: number;
} {
  const profitable = filterProfitable(rankedCandidates);
  const totalProfit = rankedCandidates.reduce((sum, c) => sum + c.expectedNetProfit, 0n);
  const avgProfit =
    rankedCandidates.length > 0 ? totalProfit / BigInt(rankedCandidates.length) : 0n;

  return {
    totalCandidates: rankedCandidates.length,
    totalProfitable: profitable.length,
    selectedCount,
    topRankProfit: rankedCandidates.length > 0 ? rankedCandidates[0]!.expectedNetProfit : null,
    bottomRankProfit:
      rankedCandidates.length > 0
        ? rankedCandidates[rankedCandidates.length - 1]!.expectedNetProfit
        : null,
    averageProfit: avgProfit,
    deferred: Math.max(0, rankedCandidates.length - selectedCount),
  };
}
