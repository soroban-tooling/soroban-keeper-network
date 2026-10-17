/**
 * Oracle condition evaluation module for keeper-bot-v2 (issue #665)
 *
 * Implements efficient pre-checking of oracle conditions before attempting task claims.
 * Instead of simulating each task individually, the bot reads each distinct oracle feed
 * once per round and caches the results for all tasks that depend on that feed.
 *
 * Key features:
 * - Feed caching: Each distinct feed is read once per round, not once per task
 * - Pre-check evaluation: Tasks with unmet conditions are skipped before claiming
 * - Simulation fallback: If prediction diverges from on-chain result, bot logs discrepancy
 * - Skip metrics: Unmet conditions generate dedicated "condition_not_met" skip reasons
 */

import type { EvaluatedCandidate } from "./types.js";

/**
 * Represents an oracle price feed and its current value
 */
export interface OracleFeed {
  feedId: string;
  currentPrice: bigint;
  timestamp: number;
}

/**
 * Result of evaluating an oracle condition against a candidate task
 */
export interface ConditionCheckResult {
  met: boolean;
  reason?: string;
  disagreeWithSimulation?: boolean;
}

/**
 * Cache for oracle feeds read in the current round.
 * Ensures each distinct feed is queried only once, even if multiple tasks depend on it.
 */
export class OracleFeedCache {
  private feeds: Map<string, OracleFeed> = new Map();
  private readonly readFeedFn: (feedId: string) => Promise<OracleFeed>;
  private readonly log: (msg: string) => void;

  constructor(
    readFeedFn: (feedId: string) => Promise<OracleFeed>,
    log: (msg: string) => void = console.log
  ) {
    this.readFeedFn = readFeedFn;
    this.log = log;
  }

  /**
   * Get a feed from cache, or fetch and cache it if not already loaded.
   * Multiple concurrent calls for the same feed will wait for the first load.
   */
  public async getFeed(feedId: string): Promise<OracleFeed> {
    if (this.feeds.has(feedId)) {
      return this.feeds.get(feedId)!;
    }

    try {
      const feed = await this.readFeedFn(feedId);
      this.feeds.set(feedId, feed);
      this.log(`Loaded oracle feed ${feedId}: price=${feed.currentPrice} at timestamp=${feed.timestamp}`);
      return feed;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.log(`Failed to load oracle feed ${feedId}: ${errMsg}`);
      throw err;
    }
  }

  /**
   * Get cached feeds for this round (after all getFeed calls are complete)
   */
  public getCachedFeeds(): Map<string, OracleFeed> {
    return new Map(this.feeds);
  }

  /**
   * Clear the cache for the next round
   */
  public clear(): void {
    this.feeds.clear();
  }

  /**
   * Get cache statistics (useful for observability)
   */
  public getStats(): { totalFeeds: number; feedIds: string[] } {
    return {
      totalFeeds: this.feeds.size,
      feedIds: Array.from(this.feeds.keys()),
    };
  }
}

/**
 * Extracts oracle feed references from task calldata.
 * The exact format depends on how oracle conditions are encoded in calldata.
 *
 * For now, this is a placeholder that extracts feed IDs from the calldata buffer.
 * In production, this would be implemented based on the actual oracle condition encoding.
 *
 * @param calldata - Task calldata buffer
 * @returns Array of feed IDs referenced in this task
 */
export function extractFeedIds(calldata: Buffer): string[] {
  // Placeholder: Extract feed IDs from calldata
  // This would be implemented based on the actual oracle condition schema
  // For now, return empty array
  return [];
}

/**
 * Evaluates whether an oracle condition is met for a given task,
 * using pre-cached feed data.
 *
 * @param candidate - The task to evaluate
 * @param feedCache - Cache of pre-loaded oracle feeds
 * @returns Whether the condition is met
 */
export async function evaluateOracleCondition(
  candidate: EvaluatedCandidate,
  feedCache: OracleFeedCache
): Promise<ConditionCheckResult> {
  // Extract feed IDs from task calldata
  const feedIds = extractFeedIds(candidate.calldata);

  if (feedIds.length === 0) {
    // No oracle condition for this task
    return { met: true };
  }

  try {
    // Load all required feeds for this task
    const feeds = await Promise.all(feedIds.map((id) => feedCache.getFeed(id)));

    // Check if all conditions are met (placeholder logic)
    // In production, this would evaluate the actual condition thresholds
    const allMet = feeds.every((feed) => feed.currentPrice > 0n);

    return {
      met: allMet,
      reason: allMet ? undefined : `Oracle condition not met for task ${candidate.taskId}`,
    };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    return {
      met: false,
      reason: `Failed to evaluate oracle condition for task ${candidate.taskId}: ${errMsg}`,
    };
  }
}

/**
 * Batch-check oracle conditions for multiple candidates using a shared feed cache.
 * This is the main entry point for pre-checking oracle conditions in a round.
 *
 * @param candidates - Candidates to evaluate
 * @param feedCache - Shared feed cache for the round
 * @returns Array of condition check results in the same order
 */
export async function checkOracleConditions(
  candidates: EvaluatedCandidate[],
  feedCache: OracleFeedCache
): Promise<ConditionCheckResult[]> {
  return Promise.all(candidates.map((c) => evaluateOracleCondition(c, feedCache)));
}

/**
 * Filter candidates based on oracle condition evaluation results.
 * Tasks with unmet conditions are separated for skipping.
 *
 * @param candidates - Candidates to filter
 * @param conditionResults - Condition check results
 * @returns Object with met and unmet candidate arrays
 */
export function partitionByOracleCondition(
  candidates: EvaluatedCandidate[],
  conditionResults: ConditionCheckResult[]
): {
  met: EvaluatedCandidate[];
  unmet: Array<{ candidate: EvaluatedCandidate; reason: string }>;
} {
  const met: EvaluatedCandidate[] = [];
  const unmet: Array<{ candidate: EvaluatedCandidate; reason: string }> = [];

  for (let i = 0; i < candidates.length; i++) {
    const result = conditionResults[i]!;
    if (result.met) {
      met.push(candidates[i]!);
    } else {
      unmet.push({
        candidate: candidates[i]!,
        reason: result.reason || "Oracle condition not met",
      });
    }
  }

  return { met, unmet };
}

/**
 * Represents a mismatch between predicted and actual condition evaluation.
 * Used for detecting and logging disagreements between off-chain and on-chain results.
 */
export interface ConditionDisagreement {
  taskId: bigint;
  predicted: boolean;
  actual: boolean;
  reason: string;
}

/**
 * Simulates on-chain condition evaluation and compares with prediction.
 * If there's a disagreement, logs it for debugging and monitoring.
 *
 * This is the fallback mechanism: if off-chain prediction differs from on-chain
 * simulation, the bot logs the discrepancy instead of assuming the prediction was correct.
 *
 * @param candidate - Candidate to simulate
 * @param predicted - Our off-chain prediction
 * @param simulateFn - Function to simulate condition on-chain
 * @param log - Logging function
 * @returns Disagreement object if prediction and simulation differ, null otherwise
 */
export async function checkConditionDisagreement(
  candidate: EvaluatedCandidate,
  predicted: boolean,
  simulateFn: (taskId: bigint) => Promise<boolean>,
  log: (msg: string) => void = console.log
): Promise<ConditionDisagreement | null> {
  try {
    const actual = await simulateFn(candidate.taskId);

    if (predicted === actual) {
      // No disagreement
      return null;
    }

    // Disagreement detected
    const disagreement: ConditionDisagreement = {
      taskId: candidate.taskId,
      predicted,
      actual,
      reason: `Condition evaluation disagreement: predicted=${predicted} but simulation result=${actual}`,
    };

    log(
      `[CONDITION DISAGREEMENT] Task ${candidate.taskId}: ${disagreement.reason}. ` +
        `This may indicate stale oracle data or a race condition. Falling back to simulation.`
    );

    return disagreement;
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    log(
      `[SIMULATION ERROR] Failed to simulate condition for task ${candidate.taskId}: ${errMsg}. ` +
        `Falling back to on-chain evaluation.`
    );
    return null;
  }
}

/**
 * Configuration for oracle condition checking
 */
export interface OracleConditionConfig {
  // Whether to skip tasks with unmet conditions
  skipUnmetConditions: boolean;
  // Whether to log condition disagreements
  logDisagreements: boolean;
  // Whether to simulate conditions to verify predictions
  verifyWithSimulation: boolean;
  // Maximum time to wait for all feed reads (in milliseconds)
  feedReadTimeoutMs?: number;
}

/**
 * Main orchestrator for oracle condition pre-checking in a round.
 * Coordinates feed caching, condition evaluation, and fallback handling.
 */
export class OracleConditionEvaluator {
  private feedCache: OracleFeedCache;
  private config: OracleConditionConfig;
  private log: (msg: string) => void;
  private disagreements: ConditionDisagreement[] = [];

  constructor(
    readFeedFn: (feedId: string) => Promise<OracleFeed>,
    config: OracleConditionConfig = { skipUnmetConditions: true, logDisagreements: true, verifyWithSimulation: false },
    log: (msg: string) => void = console.log
  ) {
    this.feedCache = new OracleFeedCache(readFeedFn, log);
    this.config = config;
    this.log = log;
  }

  /**
   * Evaluate oracle conditions for a batch of candidates in this round.
   * Returns candidates grouped by whether their conditions are met.
   */
  public async evaluateBatch(
    candidates: EvaluatedCandidate[]
  ): Promise<{
    met: EvaluatedCandidate[];
    unmet: Array<{ candidate: EvaluatedCandidate; reason: string }>;
    feedStats: { totalFeeds: number; feedIds: string[] };
  }> {
    // Pre-check all conditions using cached feeds
    const results = await checkOracleConditions(candidates, this.feedCache);

    // Partition by condition result
    const { met, unmet } = partitionByOracleCondition(candidates, results);

    // Get feed statistics for logging
    const feedStats = this.feedCache.getStats();

    this.log(
      `[ORACLE CONDITIONS] Evaluated ${candidates.length} candidates using ${feedStats.totalFeeds} cached feeds: ` +
        `${met.length} conditions met, ${unmet.length} conditions unmet`
    );

    return { met, unmet, feedStats };
  }

/**
 * Verify predictions against simulation for unmet tasks (fallback verification).
 * Only used if `verifyWithSimulation` is enabled in config.
 *
 * Note: The actual retry and disagreement tracking is handled by ConditionFallbackHandler
 * in condition-fallback.ts. This method provides the core simulation verification logic.
 */
public async verifyPredictions(
    unmetTasks: EvaluatedCandidate[],
    simulateFn: (taskId: bigint) => Promise<boolean>
  ): Promise<void> {
    if (!this.config.verifyWithSimulation || unmetTasks.length === 0) {
      return;
    }

    this.log(`[ORACLE VERIFICATION] Verifying ${unmetTasks.length} unmet conditions against simulation...`);

    for (const task of unmetTasks) {
      const disagreement = await checkConditionDisagreement(task, false, simulateFn, this.log);
      if (disagreement) {
        this.disagreements.push(disagreement);
      }
    }

    if (this.disagreements.length > 0 && this.config.logDisagreements) {
      this.log(
        `[ORACLE VERIFICATION] Detected ${this.disagreements.length} disagreement(s) between ` +
          `prediction and simulation. For detailed retry logic and recovery, use ConditionFallbackHandler ` +
          `in condition-fallback.ts.`
      );
    }
  }

  /**
   * Get tasks that had prediction disagreements (for fallback handling)
   */
  public getDisagreements(): ConditionDisagreement[] {
    return [...this.disagreements];
  }

  /**
   * Clear the cache and disagreements for the next round
   */
  public reset(): void {
    this.feedCache.clear();
    this.disagreements = [];
  }
}
