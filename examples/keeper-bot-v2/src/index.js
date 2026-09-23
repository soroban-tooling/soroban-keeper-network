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

module.exports = {
  ShutdownCoordinator,
  WithdrawalStrategy,
  FixedThresholdStrategy,
  FixedScheduleStrategy,
  FeeAwareThresholdStrategy,
  WithdrawalManager,
  computeUnlockLedger,
  LockWindowScheduler,
};
