import assert from "node:assert";
import test from "node:test";

/**
 * Fee/Reward Matrix Tests for Keeper Bot V2
 *
 * Tests profitability decisions across combinations of:
 * - Varying reward amounts
 * - Varying fee estimates
 * - Different margin requirements
 * - Multiple verifier costs
 *
 * Ensures profitability logic remains correct across realistic ranges.
 */

/**
 * Profitability evaluator (reused from profitability-boundary.test.js)
 */
class ProfitabilityEvaluator {
  constructor(config = {}) {
    this.estimatedClaimFeeSroops = config.claimFee ?? 10_000n;
    this.estimatedExecuteFeeSroops = config.executeFee ?? 50_000n;
    this.estimatedWithdrawalFeeSroops = config.withdrawalFee ?? 1_000n;
    this.minProfitMarginSroops = config.minProfitMargin ?? 0n;
  }

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

  shouldSkip(task, options = {}) {
    const result = this.evaluateTask(task, options);
    return !result.profitable;
  }
}

test("profitability-matrix: base case across reward range", () => {
  const evaluator = new ProfitabilityEvaluator({
    claimFee: 10_000n,
    executeFee: 50_000n,
    withdrawalFee: 1_000n,
    minProfitMargin: 0n,
  });

  const rewardRanges = [
    { reward: 1_000n, expectedProfitable: false },
    { reward: 30_000n, expectedProfitable: false },
    { reward: 61_000n, expectedProfitable: true },
    { reward: 100_000n, expectedProfitable: true },
    { reward: 1_000_000n, expectedProfitable: true },
  ];

  rewardRanges.forEach(({ reward, expectedProfitable }) => {
    const task = { taskId: "task", reward };
    const result = evaluator.evaluateTask(task);
    assert.strictEqual(
      result.profitable,
      expectedProfitable,
      `Reward ${reward} should be ${expectedProfitable ? "profitable" : "unprofitable"}`
    );
  });
});

test("profitability-matrix: varying claim fees", () => {
  const claimFees = [1_000n, 10_000n, 50_000n, 100_000n];
  const reward = 200_000n;

  claimFees.forEach((claimFee) => {
    const evaluator = new ProfitabilityEvaluator({
      claimFee,
      executeFee: 50_000n,
      withdrawalFee: 1_000n,
      minProfitMargin: 0n,
    });

    const result = evaluator.evaluateTask({ taskId: "task", reward });
    const expectedProfit = reward - (claimFee + 50_000n + 1_000n);

    assert.strictEqual(
      result.netProfit,
      expectedProfit,
      `Claim fee ${claimFee} should result in profit ${expectedProfit}`
    );
  });
});

test("profitability-matrix: varying execute fees", () => {
  const executeFees = [5_000n, 50_000n, 100_000n, 500_000n];
  const reward = 1_000_000n;

  executeFees.forEach((executeFee) => {
    const evaluator = new ProfitabilityEvaluator({
      claimFee: 10_000n,
      executeFee,
      withdrawalFee: 1_000n,
      minProfitMargin: 0n,
    });

    const result = evaluator.evaluateTask({ taskId: "task", reward });
    const expectedProfit = reward - (10_000n + executeFee + 1_000n);

    assert.strictEqual(
      result.netProfit,
      expectedProfit,
      `Execute fee ${executeFee} should result in profit ${expectedProfit}`
    );
  });
});

test("profitability-matrix: varying verifier fees", () => {
  const verifierFees = [0n, 10_000n, 50_000n, 100_000n];
  const reward = 500_000n;

  const evaluator = new ProfitabilityEvaluator({
    claimFee: 10_000n,
    executeFee: 50_000n,
    withdrawalFee: 1_000n,
    minProfitMargin: 0n,
  });

  verifierFees.forEach((verifierFee) => {
    const result = evaluator.evaluateTask(
      { taskId: "task", reward },
      { verifierFee }
    );
    const expectedProfit = reward - (10_000n + 50_000n + verifierFee + 1_000n);

    assert.strictEqual(
      result.netProfit,
      expectedProfit,
      `Verifier fee ${verifierFee} should result in profit ${expectedProfit}`
    );
  });
});

test("profitability-matrix: varying profit margins", () => {
  const margins = [0n, 5_000n, 10_000n, 50_000n];
  const reward = 200_000n;

  margins.forEach((margin) => {
    const evaluator = new ProfitabilityEvaluator({
      claimFee: 10_000n,
      executeFee: 50_000n,
      withdrawalFee: 1_000n,
      minProfitMargin: margin,
    });

    const result = evaluator.evaluateTask({ taskId: "task", reward });
    const netProfit = reward - (10_000n + 50_000n + 1_000n);
    const expectedProfitable = netProfit >= margin;

    assert.strictEqual(
      result.profitable,
      expectedProfitable,
      `Margin ${margin} with profit ${netProfit} should be ${expectedProfitable ? "profitable" : "unprofitable"}`
    );
  });
});

test("profitability-matrix: 2D matrix reward x claim fee", () => {
  const rewards = [50_000n, 100_000n, 200_000n];
  const claimFees = [5_000n, 10_000n, 20_000n];

  const evaluator = new ProfitabilityEvaluator({
    executeFee: 50_000n,
    withdrawalFee: 1_000n,
    minProfitMargin: 0n,
  });

  const results = [];

  rewards.forEach((reward) => {
    claimFees.forEach((claimFee) => {
      const tempEval = new ProfitabilityEvaluator({
        claimFee,
        executeFee: 50_000n,
        withdrawalFee: 1_000n,
        minProfitMargin: 0n,
      });

      const result = tempEval.evaluateTask({ taskId: "task", reward });
      results.push({
        reward,
        claimFee,
        profitable: result.profitable,
      });
    });
  });

  // Verify consistency: higher reward = more likely profitable
  const rewardAtClaimFee5k = results.filter((r) => r.claimFee === 5_000n);
  let profitableCount = 0;
  rewardAtClaimFee5k.forEach((r) => {
    if (r.profitable) profitableCount++;
  });
  assert.strictEqual(profitableCount, 3, "All reward levels profitable at lowest fee");

  // Verify consistency: higher fee = less likely profitable
  const rewardAt200k = results.filter((r) => r.reward === 200_000n);
  let profitableAtHighReward = 0;
  rewardAt200k.forEach((r) => {
    if (r.profitable) profitableAtHighReward++;
  });
  assert.ok(profitableAtHighReward >= 2, "Most combinations profitable at high reward");
});

test("profitability-matrix: 2D matrix reward x verifier fee", () => {
  const rewards = [100_000n, 200_000n, 500_000n];
  const verifierFees = [0n, 25_000n, 50_000n];

  const evaluator = new ProfitabilityEvaluator({
    claimFee: 10_000n,
    executeFee: 50_000n,
    withdrawalFee: 1_000n,
    minProfitMargin: 0n,
  });

  const results = [];

  rewards.forEach((reward) => {
    verifierFees.forEach((verifierFee) => {
      const result = evaluator.evaluateTask(
        { taskId: "task", reward },
        { verifierFee }
      );
      results.push({
        reward,
        verifierFee,
        profitable: result.profitable,
        netProfit: result.netProfit,
      });
    });
  });

  // Higher reward should generally be profitable
  const highRewardResults = results.filter((r) => r.reward === 500_000n);
  const allHighRewardProfitable = highRewardResults.every((r) => r.profitable);
  assert.strictEqual(
    allHighRewardProfitable,
    true,
    "High reward profitable across verifier fees"
  );

  // Lowest reward may not be profitable with high verifier fee
  const lowRewardHighVerifier = results.find(
    (r) => r.reward === 100_000n && r.verifierFee === 50_000n
  );
  assert.strictEqual(
    lowRewardHighVerifier.profitable,
    false,
    "Low reward + high verifier unprofitable"
  );
});

test("profitability-matrix: 3D matrix reward x claim x execute fee", () => {
  const rewards = [100_000n, 500_000n];
  const claimFees = [5_000n, 20_000n];
  const executeFees = [20_000n, 100_000n];

  const results = [];

  rewards.forEach((reward) => {
    claimFees.forEach((claimFee) => {
      executeFees.forEach((executeFee) => {
        const evaluator = new ProfitabilityEvaluator({
          claimFee,
          executeFee,
          withdrawalFee: 1_000n,
          minProfitMargin: 0n,
        });

        const result = evaluator.evaluateTask({ taskId: "task", reward });
        results.push({
          reward,
          claimFee,
          executeFee,
          profitable: result.profitable,
        });
      });
    });
  });

  // Highest reward should be profitable in all cases
  const highReward = results.filter((r) => r.reward === 500_000n);
  const allHighProfitable = highReward.every((r) => r.profitable);
  assert.strictEqual(
    allHighProfitable,
    true,
    "Highest reward profitable across all fee combinations"
  );

  // Lowest reward with highest fees may be unprofitable
  const lowRewardHighFees = results.find(
    (r) =>
      r.reward === 100_000n &&
      r.claimFee === 20_000n &&
      r.executeFee === 100_000n
  );
  assert.strictEqual(
    lowRewardHighFees.profitable,
    false,
    "Lowest reward + highest fees unprofitable"
  );
});

test("profitability-matrix: edge case zero reward", () => {
  const evaluator = new ProfitabilityEvaluator({
    claimFee: 10_000n,
    executeFee: 50_000n,
    withdrawalFee: 1_000n,
    minProfitMargin: 0n,
  });

  const result = evaluator.evaluateTask({ taskId: "task", reward: 0n });

  assert.strictEqual(result.profitable, false, "Zero reward unprofitable");
  assert.strictEqual(
    result.netProfit,
    -61_000n,
    "Expected loss equals total cost"
  );
});

test("profitability-matrix: edge case very large numbers", () => {
  const evaluator = new ProfitabilityEvaluator({
    claimFee: 10_000n,
    executeFee: 50_000n,
    withdrawalFee: 1_000n,
    minProfitMargin: 0n,
  });

  const largeReward = 1_000_000_000_000n; // 1 trillion stroops
  const result = evaluator.evaluateTask({ taskId: "task", reward: largeReward });

  assert.strictEqual(result.profitable, true, "Very large reward profitable");
  assert.ok(
    result.netProfit > 999_000_000_000n,
    "Profit calculation correct at large scale"
  );
});

test("profitability-matrix: consistency across repeated evaluations", () => {
  const evaluator = new ProfitabilityEvaluator({
    claimFee: 10_000n,
    executeFee: 50_000n,
    withdrawalFee: 1_000n,
    minProfitMargin: 5_000n,
  });

  const task = { taskId: "task", reward: 100_000n };

  // Evaluate same task multiple times
  const results = [];
  for (let i = 0; i < 10; i++) {
    results.push(evaluator.evaluateTask(task));
  }

  // All results should be identical
  const firstResult = results[0];
  results.forEach((result) => {
    assert.strictEqual(result.profitable, firstResult.profitable);
    assert.strictEqual(result.netProfit, firstResult.netProfit);
  });
});

test("profitability-matrix: reward scaling with fixed costs", () => {
  const evaluator = new ProfitabilityEvaluator({
    claimFee: 10_000n,
    executeFee: 50_000n,
    withdrawalFee: 1_000n,
    minProfitMargin: 0n,
  });

  const totalCost = 61_000n;

  // Test at multiples of cost
  const multiples = [0.5, 1.0, 1.5, 2.0, 5.0];
  const results = multiples.map((mult) => {
    const reward = BigInt(Math.ceil(Number(totalCost) * mult));
    const result = evaluator.evaluateTask({ taskId: "task", reward });
    return {
      multiple: mult,
      reward,
      profitable: result.profitable,
      netProfit: result.netProfit,
    };
  });

  // Below 1x should be unprofitable
  const belowCost = results.find((r) => r.multiple === 0.5);
  assert.strictEqual(belowCost.profitable, false, "0.5x cost unprofitable");

  // At or above 1x should be profitable
  results.slice(1).forEach((r) => {
    assert.strictEqual(r.profitable, true, `${r.multiple}x cost profitable`);
  });
});

test("profitability-matrix: task type fee variations", () => {
  // Different task types might have different estimated fees
  const taskTypes = [
    { name: "simple", claimFee: 10_000n, executeFee: 30_000n },
    { name: "complex", claimFee: 10_000n, executeFee: 100_000n },
    { name: "ttl_extension", claimFee: 10_000n, executeFee: 50_000n },
  ];

  const reward = 200_000n;

  taskTypes.forEach((taskType) => {
    const evaluator = new ProfitabilityEvaluator({
      claimFee: taskType.claimFee,
      executeFee: taskType.executeFee,
      withdrawalFee: 1_000n,
      minProfitMargin: 0n,
    });

    const result = evaluator.evaluateTask({ taskId: "task", reward });
    const totalCost = taskType.claimFee + taskType.executeFee + 1_000n;
    const expectedProfit = reward - totalCost;

    assert.strictEqual(
      result.netProfit,
      expectedProfit,
      `${taskType.name} profit calculation correct`
    );
  });
});

test("profitability-matrix: margin requirement interaction with fees", () => {
  const scenarios = [
    {
      name: "high_reward_high_margin",
      reward: 1_000_000n,
      margin: 100_000n,
      shouldProfit: true,
    },
    {
      name: "medium_reward_medium_margin",
      reward: 100_000n,
      margin: 20_000n,
      shouldProfit: true,
    },
    {
      name: "low_reward_high_margin",
      reward: 100_000n,
      margin: 50_000n,
      shouldProfit: false,
    },
    {
      name: "low_reward_no_margin",
      reward: 61_000n,
      margin: 0n,
      shouldProfit: true,
    },
  ];

  scenarios.forEach((scenario) => {
    const evaluator = new ProfitabilityEvaluator({
      claimFee: 10_000n,
      executeFee: 50_000n,
      withdrawalFee: 1_000n,
      minProfitMargin: scenario.margin,
    });

    const result = evaluator.evaluateTask({
      taskId: "task",
      reward: scenario.reward,
    });

    assert.strictEqual(
      result.profitable,
      scenario.shouldProfit,
      `${scenario.name}: expected ${scenario.shouldProfit}`
    );
  });
});
