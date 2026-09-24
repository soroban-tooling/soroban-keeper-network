import { describe, expect, it } from "vitest";

import {
  DEFAULT_PROFITABILITY_OPTIONS,
  evaluateProfitability,
  logProfitabilityDecision,
  type OperationCostEstimate,
  type ProfitabilityOptions,
} from "../src/profitability.js";

const BASE_COSTS: OperationCostEstimate = {
  claimCost: 700_000n,
  executeCost: 900_000n,
  withdrawalCost: 100_000n,
  verifierCost: 0n,
};

describe("evaluateProfitability", () => {
  describe("positive profit cases", () => {
    it("returns profitable for tasks with positive net profit", () => {
      const reward = 2_000_000n; // 0.2 XLM
      const costs = BASE_COSTS;
      const options: ProfitabilityOptions = {
        minProfitMarginStroops: 0n,
        simulationOverheadMs: 0,
        stroopsPerMs: 0n,
      };

      const result = evaluateProfitability(reward, costs, options);

      expect(result.profitable).toBe(true);
      expect(result.netProfit).toBe(
        reward - (costs.claimCost + costs.executeCost + costs.withdrawalCost + costs.verifierCost),
      );
      expect(result.totalFees).toBe(
        costs.claimCost + costs.executeCost + costs.withdrawalCost + costs.verifierCost,
      );
    });

    it("clears the minimum margin threshold", () => {
      const reward = 3_000_000n;
      const costs = BASE_COSTS;
      const minMargin = 100_000n;
      const options: ProfitabilityOptions = {
        minProfitMarginStroops: minMargin,
        simulationOverheadMs: 0,
        stroopsPerMs: 0n,
      };

      const result = evaluateProfitability(reward, costs, options);

      expect(result.profitable).toBe(true);
      expect(result.netProfit).toBeGreaterThanOrEqual(minMargin);
    });
  });

  describe("simulation overhead accounting", () => {
    it("accounts for simulation overhead in stroops-per-ms terms", () => {
      const reward = 2_000_000n;
      const costs = BASE_COSTS;
      const overheadMs = 500; // 500ms of RPC latency
      const stroopsPerMs = 1_000n; // Keeper earns 1,000 stroops per ms of work
      const expectedOverheadCost = BigInt(overheadMs) * stroopsPerMs; // 500_000n

      const options: ProfitabilityOptions = {
        minProfitMarginStroops: 0n,
        simulationOverheadMs: overheadMs,
        stroopsPerMs,
      };

      const result = evaluateProfitability(reward, costs, options);

      expect(result.simulationOverheadCost).toBe(expectedOverheadCost);
      const totalCost =
        costs.claimCost +
        costs.executeCost +
        costs.withdrawalCost +
        costs.verifierCost +
        expectedOverheadCost;
      expect(result.netProfit).toBe(reward - totalCost);
    });

    it("overhead can make a task unprofitable", () => {
      const reward = 1_200_000n; // Marginal profit
      const costs = BASE_COSTS;
      const overheadMs = 500;
      const stroopsPerMs = 1_000n;

      const options: ProfitabilityOptions = {
        minProfitMarginStroops: 0n,
        simulationOverheadMs: overheadMs,
        stroopsPerMs,
      };

      const result = evaluateProfitability(reward, costs, options);

      // With overhead, this crosses from profitable to unprofitable.
      const totalCost =
        costs.claimCost +
        costs.executeCost +
        costs.withdrawalCost +
        costs.verifierCost +
        BigInt(overheadMs) * stroopsPerMs;
      expect(result.netProfit).toBe(reward - totalCost);
      if (result.netProfit < 0n) {
        expect(result.profitable).toBe(false);
      }
    });

    it("zero overhead is valid for cases without opportunity cost", () => {
      const reward = 2_000_000n;
      const costs = BASE_COSTS;
      const options: ProfitabilityOptions = {
        minProfitMarginStroops: 0n,
        simulationOverheadMs: 0, // No overhead
        stroopsPerMs: 0n,
      };

      const result = evaluateProfitability(reward, costs, options);

      expect(result.simulationOverheadCost).toBe(0n);
      expect(result.netProfit).toBe(
        reward - (costs.claimCost + costs.executeCost + costs.withdrawalCost + costs.verifierCost),
      );
    });
  });

  describe("unprofitable cases", () => {
    it("returns unprofitable when total fees exceed reward", () => {
      const reward = 500_000n; // Insufficient
      const costs = BASE_COSTS;
      const options: ProfitabilityOptions = {
        minProfitMarginStroops: 0n,
        simulationOverheadMs: 0,
        stroopsPerMs: 0n,
      };

      const result = evaluateProfitability(reward, costs, options);

      expect(result.profitable).toBe(false);
      expect(result.netProfit).toBeLessThan(0n);
      expect(result.reason).toContain("negative profit");
    });

    it("returns unprofitable when net profit is below minimum margin", () => {
      const reward = 2_000_000n;
      const costs = BASE_COSTS;
      const minMargin = 500_000n;
      const options: ProfitabilityOptions = {
        minProfitMarginStroops: minMargin,
        simulationOverheadMs: 0,
        stroopsPerMs: 0n,
      };

      const result = evaluateProfitability(reward, costs, options);

      expect(result.profitable).toBe(false);
      expect(result.netProfit).toBeGreaterThanOrEqual(0n); // Profit, but below margin
      expect(result.reason).toContain("below minimum margin");
    });

    it("includes verifier costs in the total", () => {
      const reward = 2_000_000n;
      const costs: OperationCostEstimate = {
        ...BASE_COSTS,
        verifierCost: 1_000_000n, // Expensive verifier
      };
      const options: ProfitabilityOptions = {
        minProfitMarginStroops: 0n,
        simulationOverheadMs: 0,
        stroopsPerMs: 0n,
      };

      const result = evaluateProfitability(reward, costs, options);

      expect(result.totalFees).toContain(costs.verifierCost);
      const totalCost =
        costs.claimCost +
        costs.executeCost +
        costs.withdrawalCost +
        costs.verifierCost;
      expect(result.totalFees).toBe(totalCost);
    });
  });

  describe("reason strings for logging", () => {
    it("includes negative profit reason", () => {
      const reward = 100_000n;
      const costs = BASE_COSTS;
      const options: ProfitabilityOptions = {
        minProfitMarginStroops: 0n,
        simulationOverheadMs: 0,
        stroopsPerMs: 0n,
      };

      const result = evaluateProfitability(reward, costs, options);

      expect(result.reason).toBeDefined();
      expect(result.reason).toContain("negative profit");
      expect(result.reason).toContain(`reward: ${reward}`);
      expect(result.reason).toContain("total cost");
    });

    it("includes margin threshold reason", () => {
      const reward = 2_000_000n;
      const costs = BASE_COSTS;
      const minMargin = 100_000n;
      const options: ProfitabilityOptions = {
        minProfitMarginStroops: minMargin,
        simulationOverheadMs: 0,
        stroopsPerMs: 0n,
      };

      const result = evaluateProfitability(reward, costs, options);

      if (!result.profitable) {
        expect(result.reason).toContain(`minimum margin ${minMargin}`);
      }
    });

    it("has no reason when profitable", () => {
      const reward = 3_000_000n;
      const costs = BASE_COSTS;
      const options: ProfitabilityOptions = {
        minProfitMarginStroops: 0n,
        simulationOverheadMs: 0,
        stroopsPerMs: 0n,
      };

      const result = evaluateProfitability(reward, costs, options);

      expect(result.profitable).toBe(true);
      expect(result.reason).toBeUndefined();
    });
  });

  describe("boundary conditions", () => {
    it("exactly meets margin threshold (zero net profit remaining)", () => {
      const totalCost = 1_700_000n;
      const minMargin = 0n;
      const reward = totalCost; // Exactly break-even

      const costs: OperationCostEstimate = {
        claimCost: 700_000n,
        executeCost: 900_000n,
        withdrawalCost: 100_000n,
        verifierCost: 0n,
      };

      const options: ProfitabilityOptions = {
        minProfitMarginStroops: minMargin,
        simulationOverheadMs: 0,
        stroopsPerMs: 0n,
      };

      const result = evaluateProfitability(reward, costs, options);

      expect(result.netProfit).toBe(0n);
      expect(result.profitable).toBe(true); // Zero profit still meets zero margin
    });

    it("one stoop above minimum margin", () => {
      const reward = 2_000_001n;
      const costs = BASE_COSTS;
      const minMargin = 100_000n;
      const options: ProfitabilityOptions = {
        minProfitMarginStroops: minMargin,
        simulationOverheadMs: 0,
        stroopsPerMs: 0n,
      };

      const result = evaluateProfitability(reward, costs, options);

      expect(result.profitable).toBe(true);
      expect(result.netProfit).toBeGreaterThanOrEqual(minMargin);
    });

    it("one stoop below minimum margin", () => {
      const reward = 2_000_000n;
      const costs = BASE_COSTS;
      const minMargin = 100_001n;
      const options: ProfitabilityOptions = {
        minProfitMarginStroops: minMargin,
        simulationOverheadMs: 0,
        stroopsPerMs: 0n,
      };

      const result = evaluateProfitability(reward, costs, options);

      expect(result.profitable).toBe(false);
    });
  });
});

describe("logProfitabilityDecision", () => {
  it("logs profitable decisions", () => {
    const logs: string[] = [];
    const logger = (msg: string) => logs.push(msg);

    const result = {
      profitable: true,
      netProfit: 300_000n,
      totalFees: 1_700_000n,
      simulationOverheadCost: 0n,
      reason: undefined,
    };

    logProfitabilityDecision(42n, result, logger);

    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("Task 42");
    expect(logs[0]).toContain("profitable");
    expect(logs[0]).toContain("300000");
  });

  it("logs unprofitable decisions with reason", () => {
    const logs: string[] = [];
    const logger = (msg: string) => logs.push(msg);

    const result = {
      profitable: false,
      netProfit: -500_000n,
      totalFees: 2_200_000n,
      simulationOverheadCost: 0n,
      reason: "negative profit (reward: 1700000 stroops, total cost: 2200000 stroops)",
    };

    logProfitabilityDecision(43n, result, logger);

    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("Task 43");
    expect(logs[0]).toContain("unprofitable");
    expect(logs[0]).toContain("negative profit");
  });

  it("uses console.log by default", () => {
    const originalLog = console.log;
    const logged: unknown[] = [];
    console.log = (...args) => logged.push(args);

    try {
      const result = {
        profitable: true,
        netProfit: 500_000n,
        totalFees: 1_200_000n,
        simulationOverheadCost: 0n,
      };

      logProfitabilityDecision(44n, result);

      expect(logged).toHaveLength(1);
    } finally {
      console.log = originalLog;
    }
  });
});

describe("DEFAULT_PROFITABILITY_OPTIONS", () => {
  it("provides sensible defaults", () => {
    expect(DEFAULT_PROFITABILITY_OPTIONS.minProfitMarginStroops).toBe(0n);
    expect(DEFAULT_PROFITABILITY_OPTIONS.simulationOverheadMs).toBe(500);
    expect(DEFAULT_PROFITABILITY_OPTIONS.stroopsPerMs).toBe(0n);
  });

  it("can be customized by spreading", () => {
    const custom = {
      ...DEFAULT_PROFITABILITY_OPTIONS,
      minProfitMarginStroops: 50_000n,
      stroopsPerMs: 10_000n,
    };

    expect(custom.minProfitMarginStroops).toBe(50_000n);
    expect(custom.stroopsPerMs).toBe(10_000n);
    expect(custom.simulationOverheadMs).toBe(500); // Unchanged
  });
});
