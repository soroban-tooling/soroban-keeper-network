"use strict";

/**
 * Pluggable Withdrawal Strategy Interface and Implementations for Keeper Bot v2 (Issue #400).
 *
 * In v1, withdrawals happen whenever accrued balance crosses a fixed WITHDRAW_THRESHOLD.
 * v2 introduces a pluggable strategy interface:
 * - Default: FixedThresholdStrategy matches v1 fixed-threshold approach exactly.
 * - Alternative: FixedScheduleStrategy triggers at regular intervals when balance > 0.
 * - Alternative: FeeAwareThresholdStrategy adjusts withdrawal floor based on network base fees.
 * - Interface is genuinely open for custom 3rd-party operator implementations.
 */

/**
 * Base Strategy Interface.
 */
class WithdrawalStrategy {
  /**
   * Evaluates whether a withdrawal should occur.
   * @param {Object} context
   * @param {bigint|number|string} context.balance - Current accrued keeper rewards in stroops.
   * @param {number} [context.currentLedger] - Current network ledger sequence.
   * @param {number} [context.currentTimestamp] - Current Unix timestamp in seconds.
   * @param {number} [context.baseFee] - Current network base fee in stroops.
   * @returns {{ shouldWithdraw: boolean, reason: string }}
   */
  evaluate(_context) {
    throw new Error("WithdrawalStrategy subclass must implement evaluate(context)");
  }
}

/**
 * Default Strategy: Fixed Threshold (Exact v1 Parity).
 * Triggers a withdrawal when accrued rewards meet or exceed a configured threshold.
 */
class FixedThresholdStrategy extends WithdrawalStrategy {
  /**
   * @param {bigint|number|string} [threshold=10000000n] - Minimum balance in stroops required to withdraw (default: 1 XLM = 10,000,000 stroops).
   */
  constructor(threshold = 10000000n) {
    super();
    this.threshold = BigInt(threshold);
  }

  evaluate({ balance }) {
    const bal = BigInt(balance ?? 0n);
    if (bal >= this.threshold) {
      return {
        shouldWithdraw: true,
        reason: `balance (${bal} stroops) meets or exceeds threshold (${this.threshold} stroops)`,
      };
    }
    return {
      shouldWithdraw: false,
      reason: `balance (${bal} stroops) is below threshold (${this.threshold} stroops)`,
    };
  }
}

/**
 * Alternative Strategy: Fixed Schedule.
 * Triggers a withdrawal periodically based on elapsed time, provided balance is non-zero.
 */
class FixedScheduleStrategy extends WithdrawalStrategy {
  /**
   * @param {Object} [options]
   * @param {number} [options.intervalSeconds=3600] - Seconds between scheduled withdrawals (default: 1 hour).
   * @param {number} [options.lastWithdrawalTimestamp=0] - Initial reference timestamp (seconds).
   * @param {bigint|number|string} [options.minBalance=1n] - Minimum positive balance in stroops needed to trigger withdrawal.
   */
  constructor(options = {}) {
    super();
    this.intervalSeconds = options.intervalSeconds ?? 3600;
    this.lastWithdrawalTimestamp = options.lastWithdrawalTimestamp ?? 0;
    this.minBalance = BigInt(options.minBalance ?? 1n);
  }

  evaluate({ balance, currentTimestamp }) {
    const bal = BigInt(balance ?? 0n);
    if (bal < this.minBalance) {
      return {
        shouldWithdraw: false,
        reason: `balance (${bal} stroops) is below minimum required (${this.minBalance} stroops)`,
      };
    }

    const now = currentTimestamp ?? Math.floor(Date.now() / 1000);
    const elapsed = now - this.lastWithdrawalTimestamp;

    if (elapsed >= this.intervalSeconds) {
      return {
        shouldWithdraw: true,
        reason: `scheduled interval elapsed (${elapsed}s >= ${this.intervalSeconds}s) with positive balance (${bal} stroops)`,
      };
    }

    return {
      shouldWithdraw: false,
      reason: `scheduled interval not reached (${elapsed}s < ${this.intervalSeconds}s)`,
    };
  }

  recordWithdrawal(timestamp) {
    this.lastWithdrawalTimestamp = timestamp ?? Math.floor(Date.now() / 1000);
  }
}

/**
 * Alternative Strategy: Fee-Aware Threshold.
 * Lowers withdrawal threshold during low network fee periods and raises it when congested.
 */
class FeeAwareThresholdStrategy extends WithdrawalStrategy {
  /**
   * @param {Object} [options]
   * @param {bigint|number|string} [options.normalThreshold=10000000n] - Standard threshold in stroops.
   * @param {bigint|number|string} [options.lowFeeThreshold=2000000n] - Opportunistic lower threshold during low gas.
   * @param {number} [options.lowFeeCutoff=100] - Base fee in stroops at or below which fee is considered low.
   */
  constructor(options = {}) {
    super();
    this.normalThreshold = BigInt(options.normalThreshold ?? 10000000n);
    this.lowFeeThreshold = BigInt(options.lowFeeThreshold ?? 2000000n);
    this.lowFeeCutoff = options.lowFeeCutoff ?? 100;
  }

  evaluate({ balance, baseFee = 100 }) {
    const bal = BigInt(balance ?? 0n);
    const fee = Number(baseFee);
    const isLowFee = fee <= this.lowFeeCutoff;
    const activeThreshold = isLowFee ? this.lowFeeThreshold : this.normalThreshold;

    if (bal >= activeThreshold) {
      return {
        shouldWithdraw: true,
        reason: `balance (${bal} stroops) meets ${isLowFee ? "low-fee" : "standard"} threshold (${activeThreshold} stroops at fee ${fee})`,
      };
    }

    return {
      shouldWithdraw: false,
      reason: `balance (${bal} stroops) below ${isLowFee ? "low-fee" : "standard"} threshold (${activeThreshold} stroops at fee ${fee})`,
    };
  }
}

/**
 * Withdrawal Manager: encapsulates active strategy and provides a clean evaluation facade.
 */
class WithdrawalManager {
  /**
   * @param {WithdrawalStrategy} [strategy]
   */
  constructor(strategy) {
    this.strategy = strategy ?? new FixedThresholdStrategy();
  }

  /**
   * Plugs in a custom or alternative withdrawal strategy.
   * @param {WithdrawalStrategy|{ evaluate: Function }} strategy
   */
  setStrategy(strategy) {
    if (!strategy || typeof strategy.evaluate !== "function") {
      throw new Error("Invalid withdrawal strategy: must be an object with an evaluate(context) method");
    }
    this.strategy = strategy;
  }

  /**
   * Evaluates withdrawal with current strategy.
   * @param {Object} context
   * @returns {{ shouldWithdraw: boolean, reason: string }}
   */
  shouldWithdraw(context) {
    return this.strategy.evaluate(context);
  }
}

module.exports = {
  WithdrawalStrategy,
  FixedThresholdStrategy,
  FixedScheduleStrategy,
  FeeAwareThresholdStrategy,
  WithdrawalManager,
};
