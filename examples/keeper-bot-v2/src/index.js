"use strict";

/**
 * Soroban Keeper Network — Keeper Bot v2 Core Package
 *
 * Designed for production operators running high-performance keepers.
 * Provides modular components for:
 * - Graceful shutdown and in-flight worker draining under concurrency (Issue #402)
 * - Pluggable rewards withdrawal strategies (Issue #400)
 * - Lock-window-aware task scheduling and targeted re-checks (Issue #399)
 */

const { ShutdownCoordinator } = require("./shutdown.js");
const {
  WithdrawalStrategy,
  FixedThresholdStrategy,
  FixedScheduleStrategy,
  FeeAwareThresholdStrategy,
  WithdrawalManager,
} = require("./withdrawal.js");
const {
  computeUnlockLedger,
  LockWindowScheduler,
} = require("./scheduling.js");
const { loadConfig } = require("./config.js");
const { MetricsCollector, metrics } = require("./metrics.js");
const { TaskStatus, TaskStateRegistry } = require("./state.js");
const {
  ESTIMATED_CLAIM_FEE_STROOPS,
  ESTIMATED_EXECUTE_BASE_FEE_STROOPS,
  estimateTaskProfitability,
} = require("./profitability.js");
const { prioritizeCandidates } = require("./prioritization.js");
const {
  TASK_TYPE_NAMES,
  EXECUTORS,
  ttlExtensionExecutor,
  simulatedExecutor,
  executeTaskOffChain,
} = require("./executors.js");
const {
  DEFAULT_MAX_ROUND_SPEND_STROOPS,
  isLostClaimRaceError,
  isPermanentError,
  runKeeperRound,
} = require("./loop.js");

module.exports = {
  loadConfig,
  MetricsCollector,
  metrics,
  TaskStatus,
  TaskStateRegistry,
  ESTIMATED_CLAIM_FEE_STROOPS,
  ESTIMATED_EXECUTE_BASE_FEE_STROOPS,
  estimateTaskProfitability,
  prioritizeCandidates,
  TASK_TYPE_NAMES,
  EXECUTORS,
  ttlExtensionExecutor,
  simulatedExecutor,
  executeTaskOffChain,
  DEFAULT_MAX_ROUND_SPEND_STROOPS,
  isLostClaimRaceError,
  isPermanentError,
  runKeeperRound,
  ShutdownCoordinator,
  WithdrawalStrategy,
  FixedThresholdStrategy,
  FixedScheduleStrategy,
  FeeAwareThresholdStrategy,
  WithdrawalManager,
  computeUnlockLedger,
  LockWindowScheduler,
};
