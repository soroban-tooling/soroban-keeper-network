/**
 * Profitability calculation utilities for keeper-bot-v2.
 *
 * This module provides helpers for estimating whether a task is profitable
 * before submitting claim_task, execute_task, and withdraw_rewards
 * transactions. It accounts for simulation overhead introduced by pre-submission
 * checks (issue #0397).
 *
 * **Pattern**: All state-mutating operations are now simulated before
 * submission (issue #0269). These simulations are free (no fee), but they add
 * wall-clock latency and RPC round-trip time. Profitability estimates must
 * account for this overhead.
 *
 * **Design**: Rather than introducing per-operation fee multipliers or
 * hardcoded penalties, profitability calculations should:
 *
 * 1. Simulate claim_task alone to estimate its resource cost (actual, not
 *    guessed).
 * 2. Estimate execute_task cost from historical data or a simulation with a
 *    zero/placeholder proof.
 * 3. Add a configurable per-simulation wall-clock time overhead to account for
 *    RPC latency introduced by the pre-submission checks.
 * 4. Compute net profit as: reward - claim_fee - execute_fee - withdrawal_fee
 *    - (simulation_overhead * per_ms_value).
 *
 * **Overhead accounting**: The overhead is not a direct fee but a time cost.
 * If a keeper would earn X XLM for 30 seconds of work, but pre-submission
 * simulations add 2 seconds of RPC latency, then the effective margin shrinks
 * by the value of 2 seconds' worth of work.
 *
 * This file provides types and helpers; v2 bots integrate these into their
 * candidate evaluation loop per issue #0254.
 */

import type { IntegerInput } from "./core/scval.js";

/**
 * Estimated costs for state-mutating operations, in stroops (XLM's smallest unit).
 *
 * These are used to compute net profit before submission. Each field represents
 * an estimated transaction fee; actual fees come from simulating the
 * transaction where possible.
 */
export interface OperationCostEstimate {
  /** Estimated stroops for a claim_task transaction (actual from simulation when available). */
  claimCost: bigint;

  /**
   * Estimated stroops for an execute_task transaction (actual from simulation
   * if a placeholder proof is simulated, or from historical data).
   */
  executeCost: bigint;

  /**
   * Estimated stroops for a withdraw_rewards transaction (typically small,
   * often zero if balance is already known).
   */
  withdrawalCost: bigint;

  /**
   * Estimated stroops for verifier contract calls (if any). Zero if the task
   * has no verifier.
   */
  verifierCost: bigint;
}

/**
 * Configuration for profitability evaluation, including overhead accounting
 * for simulation costs introduced by pre-submission checks (issue #0397).
 */
export interface ProfitabilityOptions {
  /**
   * Minimum net profit in stroops that a task must clear to be worth executing.
   * Tasks with net profit below this threshold are skipped.
   *
   * Default: `0n` (any non-negative profit is acceptable).
   */
  minProfitMarginStroops: bigint;

  /**
   * Wall-clock time in milliseconds typically added to the task completion
   * time by pre-submission simulation round-trips (issue #0397).
   *
   * This accounts for:
   * - RPC latency for simulating claim_task (~50-200ms per simulation)
   * - RPC latency for simulating execute_task (~50-200ms per simulation)
   * - RPC latency for simulating withdraw_rewards balance check (~50-100ms)
   *
   * Default: `500` (assumes ~500ms total latency overhead for all three checks).
   *
   * Operators can tune this based on their RPC endpoint's performance and
   * network conditions.
   */
  simulationOverheadMs: number;

  /**
   * Value in stroops per millisecond, used to compute the cost of simulation
   * overhead as a fraction of the task's reward.
   *
   * Example: If the keeper earns 1,000,000 stroops (0.1 XLM) for 1 minute of
   * work, the per-ms value is ~16,667 stroops/ms. If simulation overhead is
   * 500ms, the cost is ~8,333,500 stroops.
   *
   * Typically computed as: `reward / (deadline - now)` at evaluation time.
   *
   * Default: `0n` (simulation overhead is not deducted; set this if you want
   * to account for keeper opportunity cost).
   */
  stroopsPerMs: bigint;
}

/**
 * Result of a profitability evaluation.
 */
export interface ProfitabilityResult {
  /** Whether the task is profitable enough to claim and execute. */
  profitable: boolean;

  /** Estimated net profit in stroops after all fees and overhead. */
  netProfit: bigint;

  /** Total estimated fee (claim + execute + withdrawal + verifier). */
  totalFees: bigint;

  /** Simulation overhead cost in stroops, if accounted for. */
  simulationOverheadCost: bigint;

  /**
   * Human-readable reason why the task is unprofitable (if `profitable` is
   * false). Useful for logging.
   */
  reason?: string;
}

/**
 * Evaluates whether a task is profitable after accounting for all costs,
 * including simulation overhead.
 *
 * @param reward - The task's reward in stroops.
 * @param costs - Estimated operation costs (claim, execute, withdrawal, verifier).
 * @param options - Profitability thresholds and overhead configuration.
 * @returns A profitability result indicating whether to proceed and why or why not.
 *
 * @example
 * ```ts
 * const result = evaluateProfitability(
 *   1_000_000n, // 0.1 XLM reward
 *   {
 *     claimCost: 700_000n,
 *     executeCost: 900_000n,
 *     withdrawalCost: 100_000n,
 *     verifierCost: 500_000n,
 *   },
 *   {
 *     minProfitMarginStroops: 0n,
 *     simulationOverheadMs: 500,
 *     stroopsPerMs: 16_667n,
 *   }
 * );
 *
 * if (!result.profitable) {
 *   console.log(`Skipping task: ${result.reason}`);
 *   return;
 * }
 *
 * console.log(`Net profit: ${result.netProfit} stroops`);
 * // Proceed to claim_task
 * ```
 */
export function evaluateProfitability(
  reward: bigint,
  costs: OperationCostEstimate,
  options: ProfitabilityOptions,
): ProfitabilityResult {
  const totalFees =
    costs.claimCost +
    costs.executeCost +
    costs.withdrawalCost +
    costs.verifierCost;

  const simulationOverheadCost =
    BigInt(options.simulationOverheadMs) * options.stroopsPerMs;

  const totalCost = totalFees + simulationOverheadCost;
  const netProfit = reward - totalCost;
  const profitable = netProfit >= options.minProfitMarginStroops;

  let reason: string | undefined;
  if (!profitable) {
    if (netProfit < 0n) {
      reason = `negative profit (reward: ${reward} stroops, total cost: ${totalCost} stroops)`;
    } else {
      reason = `net profit ${netProfit} stroops below minimum margin ${options.minProfitMarginStroops} stroops`;
    }
  }

  return {
    profitable,
    netProfit,
    totalFees,
    simulationOverheadCost,
    reason,
  };
}

/**
 * Helper to log profitability evaluation results in a structured way.
 *
 * Distinguishes "unprofitable" skips from other skip reasons so operators can
 * tell whether the bot is idle for lack of tasks or for lack of profitable ones
 * (issue #0254 acceptance criterion).
 *
 * @param taskId - The task identifier.
 * @param result - The profitability result from {@link evaluateProfitability}.
 * @param logger - Optional logger function (defaults to `console.log`).
 */
export function logProfitabilityDecision(
  taskId: bigint | number,
  result: ProfitabilityResult,
  logger: (msg: string) => void = console.log,
): void {
  if (result.profitable) {
    logger(
      `Task ${taskId}: profitable (net profit: ${result.netProfit} stroops, ` +
        `fees: ${result.totalFees} stroops, overhead: ${result.simulationOverheadCost} stroops)`,
    );
  } else {
    logger(`Task ${taskId}: unprofitable — ${result.reason}`);
  }
}

/**
 * Default profitability options suitable for most keepers.
 *
 * Operators should customize `minProfitMarginStroops` and `simulationOverheadMs`
 * based on their network conditions and operational costs.
 */
export const DEFAULT_PROFITABILITY_OPTIONS: ProfitabilityOptions = {
  minProfitMarginStroops: 0n,
  simulationOverheadMs: 500,
  stroopsPerMs: 0n, // No opportunity cost by default; operators can set this
};
