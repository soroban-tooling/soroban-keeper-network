/**
 * Round processing loop for keeper-bot-v2 (issue #0253, #0261)
 *
 * This module orchestrates the keeper round workflow:
 * 1. Discover candidate tasks from events
 * 2. Pre-check oracle conditions (if any) using cached feeds (issue #665)
 * 3. Evaluate each candidate for profitability and eligibility
 * 4. Rank candidates by expected net profit (descending)
 * 5. Process ranked candidates until round budget exhausted
 * 6. Record outcomes
 *
 * Future phases will extend this with:
 * - Concurrent task processing within a round
 * - Persistent state to prevent double-claiming across restarts
 * - Fee market adaptation and resource budget enforcement
 */

import type {
  CandidateTask,
  EvaluatedCandidate,
  RoundSummary,
  KeeperBotConfig,
  RankedCandidate,
} from "./types.js";
import { rankCandidatesByProfit, selectTopCandidates } from "./ranking.js";
import type { ProfitabilityConfig } from "./profitability.js";
import type { OracleConditionEvaluator, OracleFeed } from "./conditions.js";

/**
 * Configuration for oracle condition checking in the round
 */
export interface RoundOracleConfig {
  enabled: boolean;
  readFeedFn?: (feedId: string) => Promise<OracleFeed>;
  simulateFn?: (taskId: bigint) => Promise<boolean>;
}

/**
 * Placeholder for the round processing loop.
 *
 * The actual implementation will:
 * 1. Call a task source (events, indexer, etc.) to discover candidates
 * 2. Fetch full details for each candidate from the contract
 * 3. Pre-check oracle conditions using cached feeds
 * 4. Evaluate profitability using the profitability module
 * 5. Rank by expected net profit
 * 6. Process in rank order, respecting round limits
 *
 * @param _candidates - Discovered candidate tasks
 * @param _config - Keeper bot configuration
 * @param _oracleConfig - Optional oracle condition configuration
 * @returns Summary of the completed round
 */
export async function processRound(
  _candidates: CandidateTask[],
  _config: KeeperBotConfig,
  _oracleConfig?: RoundOracleConfig
): Promise<RoundSummary> {
  // Placeholder implementation for now
  // The actual loop will be implemented as part of the full v2 package
  return {
    processed: 0,
    selected: [],
    skipped: {
      unprofitable: [],
      noExecutor: [],
      pastDeadline: [],
      conditionNotMet: [],
      other: [],
    },
    errors: [],
    totalNetProfit: 0n,
    durationMs: 0,
  };
}

/**
 * Core workflow: evaluate and rank candidates for processing, with optional oracle condition pre-checking.
 *
 * This function encapsulates the candidate evaluation and ranking logic
 * that is independent of how candidates were discovered or how the round
 * results are executed.
 *
 * When oracle condition checking is enabled, tasks with unmet conditions are
 * filtered out before profitability evaluation, saving unnecessary computation
 * and reducing RPC calls.
 *
 * @param candidates - Array of evaluated candidates
 * @param profitabilityConfig - Configuration for profitability calculation
 * @param maxTasksPerRound - Maximum tasks to process in this round
 * @param oracleEvaluator - Optional oracle condition evaluator for pre-checking
 * @returns Object with ranked candidates and unmet oracle conditions for logging
 */
export async function evaluateAndRankCandidates(
  candidates: EvaluatedCandidate[],
  profitabilityConfig: ProfitabilityConfig,
  maxTasksPerRound: number,
  oracleEvaluator?: OracleConditionEvaluator
): Promise<{
  selected: RankedCandidate[];
  skippedByCondition: Array<{ candidate: EvaluatedCandidate; reason: string }>;
}> {
  let evaluationCandidates = candidates;
  const skippedByCondition: Array<{ candidate: EvaluatedCandidate; reason: string }> = [];

  // Step 1: Pre-check oracle conditions if evaluator provided
  if (oracleEvaluator) {
    const { met, unmet } = await oracleEvaluator.evaluateBatch(candidates);
    evaluationCandidates = met;
    skippedByCondition.push(...unmet);
  }

  // Step 2: Rank remaining candidates by expected net profit (descending)
  const ranked = rankCandidatesByProfit(evaluationCandidates, profitabilityConfig);

  // Step 3: Select top N candidates to process in this round
  const selected = selectTopCandidates(ranked, maxTasksPerRound);

  return { selected, skippedByCondition };
}
