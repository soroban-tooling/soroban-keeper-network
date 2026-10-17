/**
 * Logging utilities for oracle condition prediction monitoring (issue #0426)
 *
 * Tracks and logs:
 * 1. Prediction/reality mismatches for anomaly detection
 * 2. Fallback to simulation when feed reads fail
 * 3. Oracle feed health metrics (read counts, latencies, error rates)
 *
 * Used to monitor oracle feed reliability and detect issues with the
 * prediction algorithm or the oracle service itself.
 */

import type { ConditionMismatch } from "./conditions.js";

export interface OracleEventLog {
  timestamp: number; // Unix seconds
  type: "mismatch" | "fallback" | "feed_error" | "feed_success";
  taskId: bigint;
  feedId?: string;
  predicted?: boolean;
  actual?: boolean;
  reason?: string;
  details?: Record<string, unknown>;
}

/**
 * Logger for oracle prediction events and mismatches.
 *
 * Provides structured logging for:
 * - Prediction/reality disagreements (anomalies to investigate)
 * - Fallback to simulation (when feed read fails)
 * - Oracle feed health metrics
 */
export class OracleConditionLogger {
  private events: OracleEventLog[] = [];
  private mismatchCount = 0;
  private fallbackCount = 0;
  private feedSuccessCount = 0;
  private feedErrorCount = 0;

  private log: (message: string) => void;

  constructor(logger?: (message: string) => void) {
    this.log = logger || console.log;
  }

  /**
   * Log a prediction/reality mismatch.
   *
   * This indicates either:
   * 1. A bug in the oracle condition prediction logic
   * 2. A delayed oracle feed update (race condition)
   * 3. An issue with the oracle service (stale data, downtime, etc.)
   *
   * @param mismatch The mismatch details
   */
  logMismatch(mismatch: ConditionMismatch): void {
    this.mismatchCount++;
    const feedIdStr = mismatch.feedId ? `${mismatch.feedId.base}/${mismatch.feedId.quote}` : "unknown";

    const event: OracleEventLog = {
      timestamp: mismatch.timestamp,
      type: "mismatch",
      taskId: mismatch.taskId,
      feedId: feedIdStr,
      predicted: mismatch.predicted,
      actual: mismatch.actual,
      reason: mismatch.description,
    };

    this.events.push(event);

    // Log the mismatch at WARN level (unexpected, but recoverable)
    this.log(
      `[WARN] Oracle condition mismatch: taskId=${mismatch.taskId} feed=${feedIdStr} predicted=${mismatch.predicted} actual=${mismatch.actual} (${mismatch.description})`
    );
  }

  /**
   * Log a fallback to on-chain simulation due to feed read failure.
   *
   * This is expected behavior when:
   * 1. Oracle service is temporarily unavailable
   * 2. Network connectivity issues prevent feed read
   * 3. Configured oracle source is unreliable
   *
   * Fallbacks are not errors, but indicate an extra RPC call was needed
   * (reducing the efficiency of the oracle precheck optimization).
   *
   * @param taskId Task ID that fell back to simulation
   * @param feedId The oracle feed that failed to read
   * @param reason Why the fallback occurred (error message)
   */
  logFallbackToSimulation(taskId: bigint, feedId: string, reason: string): void {
    this.fallbackCount++;

    const event: OracleEventLog = {
      timestamp: Math.floor(Date.now() / 1000),
      type: "fallback",
      taskId,
      feedId,
      reason,
    };

    this.events.push(event);

    // Log at INFO level (expected in some scenarios, but worth tracking)
    this.log(`[INFO] Fallback to simulation for task ${taskId} (feed=${feedId}): ${reason}`);
  }

  /**
   * Log a successful oracle feed read.
   *
   * Used for telemetry to monitor oracle feed availability and performance.
   *
   * @param feedId The oracle feed that was read
   * @param latencyMs Read latency in milliseconds (if available)
   */
  logFeedSuccess(feedId: string, latencyMs?: number): void {
    this.feedSuccessCount++;

    const event: OracleEventLog = {
      timestamp: Math.floor(Date.now() / 1000),
      type: "feed_success",
      taskId: 0n, // No task associated with feed read itself
      feedId,
      details: latencyMs ? { latencyMs } : undefined,
    };

    this.events.push(event);
  }

  /**
   * Log an oracle feed read error.
   *
   * Used for telemetry to detect oracle service issues, network problems,
   * or configuration errors.
   *
   * @param feedId The oracle feed that failed
   * @param error The error that occurred
   */
  logFeedError(feedId: string, error: Error | string): void {
    this.feedErrorCount++;

    const errorMsg = error instanceof Error ? error.message : String(error);

    const event: OracleEventLog = {
      timestamp: Math.floor(Date.now() / 1000),
      type: "feed_error",
      taskId: 0n, // No task associated with feed read itself
      feedId,
      reason: errorMsg,
    };

    this.events.push(event);

    // Log at WARN level; feed errors reduce optimization efficiency
    this.log(`[WARN] Oracle feed read error for ${feedId}: ${errorMsg}`);
  }

  /**
   * Get all logged events.
   *
   * @returns Array of logged events in chronological order
   */
  getEvents(): OracleEventLog[] {
    return [...this.events];
  }

  /**
   * Get statistics about oracle operation during this session.
   */
  getStats(): {
    totalEvents: number;
    mismatches: number;
    fallbacks: number;
    feedSuccesses: number;
    feedErrors: number;
    feedErrorRate: number; // percentage
  } {
    const totalFeedOps = this.feedSuccessCount + this.feedErrorCount;
    const errorRate = totalFeedOps > 0 ? (this.feedErrorCount / totalFeedOps) * 100 : 0;

    return {
      totalEvents: this.events.length,
      mismatches: this.mismatchCount,
      fallbacks: this.fallbackCount,
      feedSuccesses: this.feedSuccessCount,
      feedErrors: this.feedErrorCount,
      feedErrorRate: errorRate,
    };
  }

  /**
   * Clear all logged events and reset statistics.
   *
   * Called between rounds to maintain separate telemetry per round.
   */
  reset(): void {
    this.events = [];
    this.mismatchCount = 0;
    this.fallbackCount = 0;
    this.feedSuccessCount = 0;
    this.feedErrorCount = 0;
  }

  /**
   * Get a summary report of oracle operation.
   *
   * @returns Formatted string suitable for logging
   */
  getSummaryReport(): string {
    const stats = this.getStats();
    const lines = [
      "=== Oracle Condition Monitoring Summary ===",
      `Total events logged: ${stats.totalEvents}`,
      `Prediction mismatches: ${stats.mismatches}`,
      `Fallbacks to simulation: ${stats.fallbacks}`,
      `Feed successes: ${stats.feedSuccesses}`,
      `Feed errors: ${stats.feedErrors}`,
      `Feed error rate: ${stats.feedErrorRate.toFixed(2)}%`,
    ];

    if (stats.mismatches > 0) {
      lines.push(
        "[ALERT] Prediction mismatches detected. Review oracle feed reliability and prediction logic."
      );
    }

    if (stats.feedErrorRate > 10) {
      lines.push(`[ALERT] Feed error rate above 10%. Oracle service may be unreliable.`);
    }

    return lines.join("\n");
  }
}

/**
 * Validate a prediction against actual on-chain result and log any mismatch.
 *
 * Called after task execution to validate oracle condition predictions.
 *
 * @param taskId Task ID
 * @param feedId Oracle feed identifier
 * @param predicted Predicted outcome from oracle feed
 * @param actual Actual outcome from on-chain evaluation
 * @param logger Logger instance to record the mismatch
 */
export function validateAndLogPrediction(
  taskId: bigint,
  feedId: string | undefined,
  predicted: boolean,
  actual: boolean,
  logger: OracleConditionLogger
): void {
  if (predicted === actual) {
    // Prediction correct; no mismatch
    return;
  }

  // Mismatch detected
  const mismatch: ConditionMismatch = {
    taskId,
    feedId: feedId ? parseFeedId(feedId) : undefined,
    predicted,
    actual,
    timestamp: Math.floor(Date.now() / 1000),
    description: `Prediction ${predicted} disagreed with on-chain result ${actual}`,
  };

  logger.logMismatch(mismatch);
}

/**
 * Parse a feed ID string (e.g., "BTC/USD") into base and quote components.
 *
 * @param feedIdStr Feed ID string
 * @returns Parsed feed ID, or undefined if parsing fails
 */
function parseFeedId(feedIdStr: string): { base: string; quote: string } | undefined {
  const parts = feedIdStr.split("/");
  if (parts.length !== 2) {
    return undefined;
  }
  return {
    base: parts[0],
    quote: parts[1],
  };
}
