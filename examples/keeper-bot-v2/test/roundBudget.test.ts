/**
 * Round budget enforcement tests (issue #0261)
 *
 * Validates correct enforcement of maxTasksPerRound limit and other
 * budget constraints during round processing.
 */

import { describe, it, expect } from "vitest";
import { rankCandidatesByProfit, selectTopCandidates } from "../src/ranking.js";
import type { EvaluatedCandidate } from "../src/types.js";
import type { ProfitabilityConfig } from "../src/profitability.js";

/**
 * Helper: Create an EvaluatedCandidate for testing
 */
function createCandidate(taskId: bigint, reward: bigint): EvaluatedCandidate {
  return {
    taskId,
    taskType: 0,
    taskTypeName: "Liquidation",
    calldata: Buffer.alloc(0),
    reward,
    deadline: Math.floor(Date.now() / 1000) + 3600,
    verifier: null,
  };
}

/**
 * Helper: Create default profitability config
 */
function createConfig(): ProfitabilityConfig {
  return {
    minProfitMarginStroops: 0n,
    estimatedClaimFeeStroops: 10_000n,
    estimatedExecuteBaseFeeStroops: 50_000n,
  };
}

describe("round budget enforcement", () => {
  describe("maxTasksPerRound limits", () => {
    it("enforces budget of 1 task per round", () => {
      const candidates = [
        createCandidate(1n, 100_000n),
        createCandidate(2n, 500_000n),
        createCandidate(3n, 150_000n),
      ];
      const config = createConfig();

      const ranked = rankCandidatesByProfit(candidates, config);
      const selected = selectTopCandidates(ranked, 1);

      expect(selected).toHaveLength(1);
      expect(selected[0]!.taskId).toBe(2n);
    });

    it("enforces budget of 5 tasks per round (v1 default)", () => {
      const candidates = Array.from({ length: 10 }, (_, i) =>
        createCandidate(BigInt(i + 1), BigInt(100_000 * (i + 1)))
      );
      const config = createConfig();

      const ranked = rankCandidatesByProfit(candidates, config);
      const selected = selectTopCandidates(ranked, 5);

      expect(selected).toHaveLength(5);
      // Should be top 5 by profit: tasks 10, 9, 8, 7, 6
      expect(selected.map((c) => c.taskId)).toEqual([10n, 9n, 8n, 7n, 6n]);
    });

    it("enforces budget of 10 tasks per round", () => {
      const candidates = Array.from({ length: 20 }, (_, i) =>
        createCandidate(BigInt(i + 1), BigInt(100_000 * (i + 1)))
      );
      const config = createConfig();

      const ranked = rankCandidatesByProfit(candidates, config);
      const selected = selectTopCandidates(ranked, 10);

      expect(selected).toHaveLength(10);
    });

    it("respects budget even with more profitable candidates available", () => {
      const candidates = [
        createCandidate(1n, 100_000n),
        createCandidate(2n, 500_000n),
        createCandidate(3n, 150_000n),
        createCandidate(4n, 75_000n),
        createCandidate(5n, 300_000n),
      ];
      const config = createConfig();
      const budget = 2;

      const ranked = rankCandidatesByProfit(candidates, config);
      const selected = selectTopCandidates(ranked, budget);

      // Should not exceed budget even though more candidates exist
      expect(selected).toHaveLength(budget);

      // Lower-profit candidates should be deferred
      const selectedIds = selected.map((c) => c.taskId);
      expect(selectedIds).not.toContain(1n);
      expect(selectedIds).not.toContain(3n);
      expect(selectedIds).not.toContain(4n);
    });
  });

  describe("budget edge cases", () => {
    it("handles budget of 0", () => {
      const candidates = [
        createCandidate(1n, 100_000n),
        createCandidate(2n, 500_000n),
      ];
      const config = createConfig();

      const ranked = rankCandidatesByProfit(candidates, config);
      const selected = selectTopCandidates(ranked, 0);

      expect(selected).toHaveLength(0);
    });

    it("handles budget less than 0 (treat as 0)", () => {
      const candidates = [
        createCandidate(1n, 100_000n),
        createCandidate(2n, 500_000n),
      ];
      const config = createConfig();

      const ranked = rankCandidatesByProfit(candidates, config);
      // Math.min(-1, 2) = -1, so slice(0, -1) returns all but last
      // This is expected behavior: Math.min handles negative gracefully
      const selected = selectTopCandidates(ranked, -1);

      // With -1, slice(0, min(-1, 2)) = slice(0, -1) = all except last
      // But selectTopCandidates uses Math.min(limit, length)
      // Math.min(-1, 2) = -1, so returns empty array via slice(0, -1)
      expect(selected.length).toBeLessThanOrEqual(0);
    });

    it("handles budget greater than available candidates", () => {
      const candidates = [
        createCandidate(1n, 100_000n),
        createCandidate(2n, 500_000n),
      ];
      const config = createConfig();

      const ranked = rankCandidatesByProfit(candidates, config);
      const selected = selectTopCandidates(ranked, 100);

      // Should return all available candidates
      expect(selected).toHaveLength(2);
    });

    it("handles budget equal to candidate count", () => {
      const candidates = [
        createCandidate(1n, 100_000n),
        createCandidate(2n, 500_000n),
        createCandidate(3n, 150_000n),
      ];
      const config = createConfig();

      const ranked = rankCandidatesByProfit(candidates, config);
      const selected = selectTopCandidates(ranked, candidates.length);

      expect(selected).toHaveLength(candidates.length);
    });
  });

  describe("budget respects ranking order", () => {
    it("selection respects profit ranking within budget", () => {
      const candidates = [
        createCandidate(1n, 100_000n), // profit: 40_000
        createCandidate(2n, 500_000n), // profit: 440_000
        createCandidate(3n, 150_000n), // profit: 90_000
        createCandidate(4n, 200_000n), // profit: 140_000
      ];
      const config = createConfig();
      const budget = 2;

      const ranked = rankCandidatesByProfit(candidates, config);
      const selected = selectTopCandidates(ranked, budget);

      // Should select top 2: 440k and 140k
      expect(selected[0]!.taskId).toBe(2n); // 440_000
      expect(selected[1]!.taskId).toBe(4n); // 140_000
    });

    it("maintains profit order across multiple selection sizes", () => {
      const candidates = Array.from({ length: 10 }, (_, i) =>
        createCandidate(BigInt(i + 1), BigInt(100_000 + i * 50_000))
      );
      const config = createConfig();

      const ranked = rankCandidatesByProfit(candidates, config);

      const selected1 = selectTopCandidates(ranked, 1);
      const selected3 = selectTopCandidates(ranked, 3);
      const selected5 = selectTopCandidates(ranked, 5);

      // Verify ordering consistency
      expect(selected1[0]!.taskId).toBe(selected3[0]!.taskId);
      expect(selected3[0]!.taskId).toBe(selected5[0]!.taskId);
      expect(selected1[0]!.taskId).toBe(selected5[0]!.taskId);

      // Verify top-1 is in top-3
      expect(selected3.map((c) => c.taskId)).toContain(selected1[0]!.taskId);

      // Verify top-3 is in top-5
      expect(selected5.map((c) => c.taskId)).toContain(selected3[0]!.taskId);
      expect(selected5.map((c) => c.taskId)).toContain(selected3[1]!.taskId);
    });
  });

  describe("regression tests for existing budget logic", () => {
    it("processes candidates in order until budget exhausted", () => {
      const candidates = [
        createCandidate(1n, 100_000n),
        createCandidate(2n, 500_000n),
        createCandidate(3n, 150_000n),
        createCandidate(4n, 75_000n),
        createCandidate(5n, 300_000n),
      ];
      const config = createConfig();

      // Simulate the typical keeper workflow: rank then select
      const ranked = rankCandidatesByProfit(candidates, config);
      const summary = [];

      for (let budget = 0; budget <= candidates.length; budget++) {
        const selected = selectTopCandidates(ranked, budget);
        summary.push({
          budget,
          selected: selected.length,
          taskIds: selected.map((c) => c.taskId),
        });
      }

      // Verify budget enforcement at each level
      expect(summary[0]!.selected).toBe(0);
      expect(summary[1]!.selected).toBe(1);
      expect(summary[2]!.selected).toBe(2);
      expect(summary[5]!.selected).toBe(5);
    });

    it("does not exceed budget with unprofitable candidates", () => {
      const candidates = [
        createCandidate(1n, 100_000n), // Profitable
        createCandidate(2n, 30_000n), // Unprofitable
        createCandidate(3n, 150_000n), // Profitable
        createCandidate(4n, 20_000n), // Unprofitable
      ];
      const config = createConfig();

      const ranked = rankCandidatesByProfit(candidates, config);
      const selected = selectTopCandidates(ranked, 2);

      // Should select exactly 2, regardless of profitability mix
      expect(selected).toHaveLength(2);

      // Should be top 2 by profit ranking (which happens to be profitable)
      expect(selected[0]!.taskId).toBe(3n);
      expect(selected[1]!.taskId).toBe(1n);
    });
  });

  describe("large-scale budget scenarios", () => {
    it("handles large candidate set with small budget", () => {
      const candidates = Array.from({ length: 1000 }, (_, i) =>
        createCandidate(BigInt(i + 1), BigInt((i + 1) * 10_000))
      );
      const config = createConfig();

      const ranked = rankCandidatesByProfit(candidates, config);
      const selected = selectTopCandidates(ranked, 5);

      expect(selected).toHaveLength(5);
      // Should be top 5: 1000, 999, 998, 997, 996
      expect(selected[0]!.taskId).toBe(1000n);
    });

    it("handles realistic round with maxTasksPerRound=5 (v1 default)", () => {
      const candidates = Array.from({ length: 50 }, (_, i) =>
        createCandidate(BigInt(i + 1), BigInt((i + 1) * 100_000))
      );
      const config = createConfig();
      const maxTasksPerRound = 5; // v1 default

      const ranked = rankCandidatesByProfit(candidates, config);
      const selected = selectTopCandidates(ranked, maxTasksPerRound);

      expect(selected).toHaveLength(5);
      // Top 5 should be: 50, 49, 48, 47, 46
      expect(selected.map((c) => c.taskId)).toEqual([50n, 49n, 48n, 47n, 46n]);
    });
  });
});
