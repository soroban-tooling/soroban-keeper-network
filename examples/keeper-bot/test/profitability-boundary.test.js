import assert from "node:assert";
import test from "node:test";

/**
 * Profitability Boundary Tests for Keeper Bot V2
 *
 * Tests that verify profitability decisions at:
 * - Exactly the margin threshold
 * - Just below the margin threshold
 * - Just above the margin threshold
 *
 * Follows the boundary-testing discipline used throughout the contract test suites.
 * Based on issue #0254 requirements.
 */

/**
 * Profitability evaluator matching v1's logic
 * Simulates claim + execute + withdrawal costs against reward
 */
class ProfitabilityEvaluator {
  constructor(config = {}) {
    this.estimatedClaimFeeSroops = config.claimFee ?? 10_000n;
    this.estimatedExecuteFeeSroops = config.executeFee ?? 50_000n;
    this.estimatedWithdrawalFeeSroops = config.withdrawalFee ?? 1_000n;
    this.minProfitMarginSroops = config.minProfitMargin ?? 0n;
  }

  /**
   * Evaluate if a task is profitable
   * Returns {profitable, netProfit, estimatedCost, breakdown}
   */
  evaluateTask(task, options = {}) {
    const verifierFee = options.verifierFee ?? 0n;
    const estimatedTotalCost =
      this.estimatedClaimFeeSroops +
      this.estimatedExecuteFeeSroops +
      verifierFee +
      this.estimatedWithdrawalFeeSroops;

    const netProfit = BigInt(task.reward) - estimatedTotalCost;
    const profitable = netProfit >= this.minProfitMarginSroops;

    return {
      profitable,
      netProfit,
      estimatedCost: estimatedTotalCost,
      breakdown: {
        reward: BigInt(task.reward),
        claimFee: this.estimatedClaimFeeSroops,
        executeFee: this.estimatedExecuteFeeSroops,
        verifierFee,
        withdrawalFee: this.estimatedWithdrawalFeeSroops,
        minMargin: this.minProfitMarginSroops,
      },
    };
  }

  /**
   * Determine if task should be skipped for profitability
   * (before claiming, not after)
   */
  shouldSkip(task, options = {}) {
    const result = this.evaluateTask(task, options);
    return !result.profitable;
  }
}

/**
 * Test cases for boundary conditions
 */

test("profitability: exactly at margin threshold", () => {
  const evaluator = new ProfitabilityEvaluator({
    claimFee: 10_000n,
    executeFee: 50_000n,
    withdrawalFee: 1_000n,
    minProfitMargin: 0n, // Margin is 0, so break-even is profitable
  });

  const task = {
    taskId: "task-1",
    reward: 61_000n, // Exactly covers claim + execute + withdrawal
  };

  const result = evaluator.evaluateTask(task);

  assert.strictEqual(result.profitable, true, "Break-even should be profitable when margin is 0");
  assert.strictEqual(
    result.netProfit,
    0n,
    "Net profit should be exactly 0"
  );
});

test("profitability: just below margin threshold", () => {
  const evaluator = new ProfitabilityEvaluator({
    claimFee: 10_000n,
    executeFee: 50_000n,
    withdrawalFee: 1_000n,
    minProfitMargin: 0n,
  });

  const task = {
    taskId: "task-1",
    reward: 60_999n, // 1 stroop short of break-even
  };

  const result = evaluator.evaluateTask(task);

  assert.strictEqual(
    result.profitable,
    false,
    "Task 1 stroop below break-even should be unprofitable"
  );
  assert.strictEqual(
    result.netProfit,
    -1n,
    "Net profit should be -1"
  );
});

test("profitability: just above margin threshold", () => {
  const evaluator = new ProfitabilityEvaluator({
    claimFee: 10_000n,
    executeFee: 50_000n,
    withdrawalFee: 1_000n,
    minProfitMargin: 0n,
  });

  const task = {
    taskId: "task-1",
    reward: 61_001n, // 1 stroop above break-even
  };

  const result = evaluator.evaluateTask(task);

  assert.strictEqual(
    result.profitable,
    true,
    "Task 1 stroop above break-even should be profitable"
  );
  assert.strictEqual(
    result.netProfit,
    1n,
    "Net profit should be +1"
  );
});

test("profitability: at positive margin threshold", () => {
  const evaluator = new ProfitabilityEvaluator({
    claimFee: 10_000n,
    executeFee: 50_000n,
    withdrawalFee: 1_000n,
    minProfitMargin: 5_000n, // Require 5k stroops profit minimum
  });

  const task = {
    taskId: "task-1",
    reward: 66_000n, // Exactly margin
  };

  const result = evaluator.evaluateTask(task);

  assert.strictEqual(
    result.profitable,
    true,
    "Task exactly at margin should be profitable"
  );
  assert.strictEqual(
    result.netProfit,
    5_000n,
    "Net profit should exactly match margin"
  );
});

test("profitability: just below positive margin threshold", () => {
  const evaluator = new ProfitabilityEvaluator({
    claimFee: 10_000n,
    executeFee: 50_000n,
    withdrawalFee: 1_000n,
    minProfitMargin: 5_000n,
  });

  const task = {
    taskId: "task-1",
    reward: 65_999n, // 1 stroop below margin
  };

  const result = evaluator.evaluateTask(task);

  assert.strictEqual(
    result.profitable,
    false,
    "Task 1 stroop below margin should be unprofitable"
  );
  assert.strictEqual(
    result.netProfit,
    4_999n,
    "Net profit is 4999, below 5000 margin"
  );
});

test("profitability: just above positive margin threshold", () => {
  const evaluator = new ProfitabilityEvaluator({
    claimFee: 10_000n,
    executeFee: 50_000n,
    withdrawalFee: 1_000n,
    minProfitMargin: 5_000n,
  });

  const task = {
    taskId: "task-1",
    reward: 66_001n, // 1 stroop above margin
  };

  const result = evaluator.evaluateTask(task);

  assert.strictEqual(
    result.profitable,
    true,
    "Task 1 stroop above margin should be profitable"
  );
  assert.strictEqual(
    result.netProfit,
    5_001n,
    "Net profit should be margin + 1"
  );
});

test("profitability: boundary with high margin requirement", () => {
  const evaluator = new ProfitabilityEvaluator({
    claimFee: 10_000n,
    executeFee: 50_000n,
    withdrawalFee: 1_000n,
    minProfitMargin: 100_000n, // High margin requirement
  });

  // Exactly at margin
  const atMargin = { taskId: "task-1", reward: 161_000n };
  assert.strictEqual(
    evaluator.evaluateTask(atMargin).profitable,
    true,
    "At high margin threshold"
  );

  // 1 below margin
  const belowMargin = { taskId: "task-2", reward: 160_999n };
  assert.strictEqual(
    evaluator.evaluateTask(belowMargin).profitable,
    false,
    "Below high margin threshold"
  );

  // 1 above margin
  const aboveMargin = { taskId: "task-3", reward: 161_001n };
  assert.strictEqual(
    evaluator.evaluateTask(aboveMargin).profitable,
    true,
    "Above high margin threshold"
  );
});

test("profitability: boundary with verifier fee", () => {
  const evaluator = new ProfitabilityEvaluator({
    claimFee: 10_000n,
    executeFee: 50_000n,
    withdrawalFee: 1_000n,
    minProfitMargin: 0n,
  });

  const baseReward = 61_000n; // Profitable without verifier
  const verifierFee = 20_000n;

  // Without verifier: profitable
  const withoutVerifier = evaluator.evaluateTask({
    taskId: "task-1",
    reward: baseReward,
  });
  assert.strictEqual(
    withoutVerifier.profitable,
    true,
    "Profitable without verifier"
  );

  // With high verifier fee: unprofitable
  const withVerifier = evaluator.evaluateTask(
    { taskId: "task-2", reward: baseReward },
    { verifierFee }
  );
  assert.strictEqual(
    withVerifier.profitable,
    false,
    "Unprofitable with verifier fee"
  );

  // With exact compensation: profitable
  const compens = evaluator.evaluateTask(
    { taskId: "task-3", reward: baseReward + verifierFee },
    { verifierFee }
  );
  assert.strictEqual(
    compens.profitable,
    true,
    "Profitable with higher reward to cover verifier"
  );
});

test("profitability: boundary at very low reward", () => {
  const evaluator = new ProfitabilityEvaluator({
    claimFee: 10_000n,
    executeFee: 50_000n,
    withdrawalFee: 1_000n,
    minProfitMargin: 0n,
  });

  const lowReward = { taskId: "task-1", reward: 1_000n };
  const result = evaluator.evaluateTask(lowReward);

  assert.strictEqual(result.profitable, false, "Very low reward unprofitable");
  assert.strictEqual(
    result.netProfit,
    -60_001n,
    "Significant loss expected"
  );
});

test("profitability: boundary at very high reward", () => {
  const evaluator = new ProfitabilityEvaluator({
    claimFee: 10_000n,
    executeFee: 50_000n,
    withdrawalFee: 1_000n,
    minProfitMargin: 0n,
  });

  const highReward = { taskId: "task-1", reward: 1_000_000_000n };
  const result = evaluator.evaluateTask(highReward);

  assert.strictEqual(result.profitable, true, "Very high reward profitable");
  assert.ok(
    result.netProfit > 999_000_000n,
    "Substantial profit expected"
  );
});

test("profitability: decision matrix across reward/fee combinations", () => {
  const evaluator = new ProfitabilityEvaluator({
    claimFee: 10_000n,
    executeFee: 50_000n,
    withdrawalFee: 1_000n,
    minProfitMargin: 5_000n,
  });

  const testCases = [
    { reward: 50_000n, profitable: false, reason: "below_cost" },
    { reward: 61_000n, profitable: false, reason: "below_margin" },
    { reward: 66_000n, profitable: true, reason: "at_margin" },
    { reward: 100_000n, profitable: true, reason: "well_above" },
  ];

  testCases.forEach(({ reward, profitable, reason }) => {
    const result = evaluator.evaluateTask({ taskId: "test", reward });
    assert.strictEqual(
      result.profitable,
      profitable,
      `Case "${reason}": reward ${reward}`
    );
  });
});

test("profitability: margin scaling with different fee structures", () => {
  const lowCostConfig = {
    claimFee: 1_000n,
    executeFee: 5_000n,
    withdrawalFee: 100n,
    minProfitMargin: 500n,
  };

  const highCostConfig = {
    claimFee: 100_000n,
    executeFee: 500_000n,
    withdrawalFee: 10_000n,
    minProfitMargin: 50_000n,
  };

  const lowCostEval = new ProfitabilityEvaluator(lowCostConfig);
  const highCostEval = new ProfitabilityEvaluator(highCostConfig);

  // Same margin ratio, different absolute costs
  const lowCostTask = { taskId: "low", reward: 12_000n };
  const highCostTask = { taskId: "high", reward: 1_200_000n };

  const lowResult = lowCostEval.evaluateTask(lowCostTask);
  const highResult = highCostEval.evaluateTask(highCostTask);

  assert.strictEqual(lowResult.profitable, true, "Low-cost task profitable");
  assert.strictEqual(highResult.profitable, true, "High-cost task profitable");

  // Both have similar profit margin ratios
  const lowMarginRatio = lowResult.netProfit / lowResult.estimatedCost;
  const highMarginRatio = highResult.netProfit / highResult.estimatedCost;

  assert.ok(
    Math.abs(Number(lowMarginRatio) - Number(highMarginRatio)) < 0.1,
    "Margin ratios should be similar"
  );
});

test("profitability: shouldSkip mirrors profitable decision", () => {
  const evaluator = new ProfitabilityEvaluator({
    claimFee: 10_000n,
    executeFee: 50_000n,
    withdrawalFee: 1_000n,
    minProfitMargin: 5_000n,
  });

  const testCases = [
    { taskId: "unprofitable", reward: 50_000n },
    { taskId: "at_margin", reward: 66_000n },
    { taskId: "profitable", reward: 100_000n },
  ];

  testCases.forEach((task) => {
    const shouldSkip = evaluator.shouldSkip(task);
    const isNotProfitable = !evaluator.evaluateTask(task).profitable;

    assert.strictEqual(
      shouldSkip,
      isNotProfitable,
      `shouldSkip and profitable for ${task.taskId}`
    );
  });
});

test("profitability: boundary test at zero margin with different fee structures", () => {
  const configs = [
    { claimFee: 10_000n, executeFee: 50_000n, withdrawalFee: 1_000n },
    { claimFee: 1_000n, executeFee: 5_000n, withdrawalFee: 100n },
    { claimFee: 100_000n, executeFee: 500_000n, withdrawalFee: 10_000n },
  ];

  configs.forEach((config) => {
    const evaluator = new ProfitabilityEvaluator({
      ...config,
      minProfitMargin: 0n,
    });

    const breakEvenReward =
      config.claimFee + config.executeFee + config.withdrawalFee;
    const justBelowBreakEven = breakEvenReward - 1n;
    const justAboveBreakEven = breakEvenReward + 1n;

    const atBreakEven = evaluator.evaluateTask({
      taskId: "at",
      reward: breakEvenReward,
    });
    const below = evaluator.evaluateTask({
      taskId: "below",
      reward: justBelowBreakEven,
    });
    const above = evaluator.evaluateTask({
      taskId: "above",
      reward: justAboveBreakEven,
    });

    assert.strictEqual(
      atBreakEven.profitable,
      true,
      "At break-even: profitable"
    );
    assert.strictEqual(below.profitable, false, "Below break-even: unprofitable");
    assert.strictEqual(above.profitable, true, "Above break-even: profitable");
  });
});

test("profitability: breakdown shows all cost components", () => {
  const evaluator = new ProfitabilityEvaluator({
    claimFee: 10_000n,
    executeFee: 50_000n,
    withdrawalFee: 1_000n,
    minProfitMargin: 5_000n,
  });

  const task = { taskId: "task-1", reward: 100_000n };
  const result = evaluator.evaluateTask(task, { verifierFee: 20_000n });

  assert.strictEqual(result.breakdown.claimFee, 10_000n);
  assert.strictEqual(result.breakdown.executeFee, 50_000n);
  assert.strictEqual(result.breakdown.withdrawalFee, 1_000n);
  assert.strictEqual(result.breakdown.verifierFee, 20_000n);
  assert.strictEqual(result.breakdown.minMargin, 5_000n);
  assert.strictEqual(result.breakdown.reward, 100_000n);
});
