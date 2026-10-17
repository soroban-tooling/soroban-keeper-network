/**
 * Condition evaluation fallback handler for keeper-bot-v2 (issue #665)
 *
 * Manages the fallback from off-chain condition predictions to on-chain simulation
 * when disagreements are detected. This module coordinates:
 *
 * - Tracking prediction-simulation disagreements
 * - Logging discrepancies for observability
 * - Falling back to simulation for tasks with unmet predictions
 * - Updating decision-making based on actual on-chain results
 */

import type { EvaluatedCandidate } from "./types.js";
import type { ConditionDisagreement } from "./conditions.js";

/**
 * Result of fallback evaluation for a single task
 */
export interface FallbackEvaluationResult {
  taskId: bigint;
  predictedMet: boolean;
  simulatedMet: boolean;
  agreed: boolean;
  shouldAttempt: boolean;
  reason?: string;
}

/**
 * Statistics from a fallback evaluation round
 */
export interface FallbackStats {
  totalChecked: number;
  totalDisagreements: number;
  predictedUnmetButSimulatedMet: number;
  predictedMetButSimulatedUnmet: number;
  averageSimulationTimeMs: number;
}

/**
 * Manages condition evaluation fallback with comprehensive logging and disagreement tracking
 */
export class ConditionFallbackHandler {
  private disagreements: ConditionDisagreement[] = [];
  private simulationTimes: number[] = [];
  private readonly log: (msg: string) => void;

  constructor(log: (msg: string) => void = console.log) {
    this.log = log;
  }

  /**
   * Evaluate a task with fallback to simulation, comparing prediction vs actual result.
   *
   * Decision logic:
   * - If predicted == simulated: use the result
   * - If predicted != simulated: log disagreement and use simulation result
   *
   * @param candidate - Task to evaluate
   * @param predictedMet - Off-chain prediction of condition
   * @param simulateFn - Function to simulate on-chain condition
   * @returns Evaluation result with decision to attempt or skip
   */
  public async evaluateWithFallback(
    candidate: EvaluatedCandidate,
    predictedMet: boolean,
    simulateFn: (taskId: bigint) => Promise<boolean>
  ): Promise<FallbackEvaluationResult> {
    const startTime = Date.now();

    try {
      const simulatedMet = await simulateFn(candidate.taskId);
      const simulationTime = Date.now() - startTime;
      this.simulationTimes.push(simulationTime);

      const agreed = predictedMet === simulatedMet;

      if (!agreed) {
        const disagreement: ConditionDisagreement = {
          taskId: candidate.taskId,
          predicted: predictedMet,
          actual: simulatedMet,
          reason: `Predicted=${predictedMet} but simulation=${simulatedMet}`,
        };
        this.disagreements.push(disagreement);

        this.log(
          `[FALLBACK DISAGREEMENT] Task ${candidate.taskId}: ` +
            `Predicted condition=${predictedMet} but simulation result=${simulatedMet}. ` +
            `Using simulation result (${simulationTime}ms). This may indicate stale oracle data or timing race.`
        );
      }

      return {
        taskId: candidate.taskId,
        predictedMet,
        simulatedMet,
        agreed,
        shouldAttempt: simulatedMet,
        reason: agreed ? undefined : `Fallback evaluation disagreed: predicted=${predictedMet}, actual=${simulatedMet}`,
      };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const simulationTime = Date.now() - startTime;
      this.simulationTimes.push(simulationTime);

      this.log(
        `[FALLBACK SIMULATION ERROR] Task ${candidate.taskId}: ` +
          `Simulation failed after ${simulationTime}ms: ${errMsg}. ` +
          `Falling back to prediction (may be stale).`
      );

      return {
        taskId: candidate.taskId,
        predictedMet,
        simulatedMet: predictedMet, // Fall back to prediction on simulation error
        agreed: true,
        shouldAttempt: predictedMet,
        reason: `Simulation failed: ${errMsg}`,
      };
    }
  }

  /**
   * Batch-evaluate multiple tasks with fallback to simulation.
   * Useful for verifying a set of tasks with unmet predictions.
   */
  public async evaluateBatchWithFallback(
    candidates: EvaluatedCandidate[],
    predictedMet: Map<bigint, boolean>,
    simulateFn: (taskId: bigint) => Promise<boolean>
  ): Promise<FallbackEvaluationResult[]> {
    const results: FallbackEvaluationResult[] = [];

    for (const candidate of candidates) {
      const predicted = predictedMet.get(candidate.taskId) ?? false;
      const result = await this.evaluateWithFallback(candidate, predicted, simulateFn);
      results.push(result);
    }

    return results;
  }

  /**
   * Get all disagreements detected so far in this handler instance
   */
  public getDisagreements(): ConditionDisagreement[] {
    return [...this.disagreements];
  }

  /**
   * Get statistics about fallback evaluations
   */
  public getStats(): FallbackStats {
    const predictedUnmetButSimulatedMet = this.disagreements.filter(
      (d) => !d.predicted && d.actual
    ).length;
    const predictedMetButSimulatedUnmet = this.disagreements.filter(
      (d) => d.predicted && !d.actual
    ).length;

    const avgTime =
      this.simulationTimes.length > 0
        ? this.simulationTimes.reduce((a, b) => a + b, 0) / this.simulationTimes.length
        : 0;

    return {
      totalChecked: this.simulationTimes.length,
      totalDisagreements: this.disagreements.length,
      predictedUnmetButSimulatedMet,
      predictedMetButSimulatedUnmet,
      averageSimulationTimeMs: avgTime,
    };
  }

  /**
   * Log a summary of fallback statistics
   */
  public logStats(): void {
    const stats = this.getStats();
    if (stats.totalDisagreements === 0) {
      this.log(
        `[FALLBACK SUMMARY] No disagreements detected across ${stats.totalChecked} simulations (avg ${stats.averageSimulationTimeMs.toFixed(1)}ms)`
      );
      return;
    }

    this.log(
      `[FALLBACK SUMMARY] ${stats.totalDisagreements} disagreements across ${stats.totalChecked} simulations (avg ${stats.averageSimulationTimeMs.toFixed(1)}ms): ` +
        `${stats.predictedUnmetButSimulatedMet} predicted-unmet-but-simulated-met, ` +
        `${stats.predictedMetButSimulatedUnmet} predicted-met-but-simulated-unmet`
    );
  }

  /**
   * Clear all tracked disagreements and statistics for the next round
   */
  public reset(): void {
    this.disagreements = [];
    this.simulationTimes = [];
  }
}

/**
 * Retry policy for condition fallback evaluations that fail
 */
export interface ConditionFallbackRetryPolicy {
  maxRetries: number;
  initialDelayMs: number;
  maxDelayMs: number;
  backoffMultiplier: number;
}

/**
 * Default retry policy for condition fallback
 */
export const DEFAULT_FALLBACK_RETRY_POLICY: ConditionFallbackRetryPolicy = {
  maxRetries: 3,
  initialDelayMs: 100,
  maxDelayMs: 5000,
  backoffMultiplier: 2,
};

/**
 * Utility for retrying condition simulations with exponential backoff
 */
export class ConditionFallbackRetry {
  constructor(private policy: ConditionFallbackRetryPolicy = DEFAULT_FALLBACK_RETRY_POLICY) {}

  /**
   * Execute a simulation function with retry logic
   */
  public async executeWithRetry<T>(
    fn: () => Promise<T>,
    context: string = "condition simulation"
  ): Promise<T> {
    let lastError: Error | null = null;
    let delay = this.policy.initialDelayMs;

    for (let attempt = 0; attempt <= this.policy.maxRetries; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));

        if (attempt < this.policy.maxRetries) {
          const nextDelay = Math.min(delay * this.policy.backoffMultiplier, this.policy.maxDelayMs);
          await this.sleep(delay);
          delay = nextDelay;
        }
      }
    }

    throw new Error(
      `Failed to execute ${context} after ${this.policy.maxRetries + 1} attempts: ${lastError?.message}`
    );
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

/**
 * Integration point: combine prediction and simulation for final decision
 *
 * This function encapsulates the decision logic for whether a task should be attempted
 * after considering both off-chain predictions and on-chain simulations.
 *
 * @param predicted - Off-chain prediction
 * @param simulated - On-chain simulation result (or null if simulation failed)
 * @param preferFallback - Prefer simulation over prediction when available
 * @returns Final decision to attempt or skip
 */
export function decideFinalConditionStatus(
  predicted: boolean,
  simulated: boolean | null,
  preferFallback: boolean = true
): boolean {
  if (simulated !== null && preferFallback) {
    // Prefer simulation result if available and enabled
    return simulated;
  }

  // Fall back to prediction
  return predicted;
}
