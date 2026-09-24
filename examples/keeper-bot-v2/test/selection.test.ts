/**
 * Mixed reward selection tests (issue #0261)
 *
 * Critical acceptance test: when a round cannot process every candidate,
 * the most profitable opportunities are selected first, not based on arrival order.
 *
 * This test directly validates Acceptance Criterion #2 from issue #0261.
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

describe("mixed reward selection", () => {
  describe("round budget enforcement with mixed rewards", () => {
    it("selects high-profit candidates over low-profit when budget limited", () => {
      // Round budget allows only 2 tasks, but we have 5 candidates
      const candidates = [
        createCandidate(1n, 100_000n), // profit: 40_000
        createCandidate(2n, 500_000n), // profit: 440_000 (highest)
        createCandidate(3n, 150_000n), // profit: 90_000
        createCandidate(4n, 75_000n), // profit: 15_000
        createCandidate(5n, 300_000n), // profit: 240_000 (second highest)
      ];
      const config = createConfig();
      const maxTasksPerRound = 2;

      const ranked = rankCandidatesByProfit(candidates, config);
      const selected = selectTopCandidates(ranked, maxTasksPerRound);

      // Should select the two highest profit tasks
      expect(selected).toHaveLength(2);
      expect(selected[0]!.taskId).toBe(2n); // 440_000
      expect(selected[1]!.taskId).toBe(5n); // 240_000
    });

    it("selects in descending profit order for 3-task round budget", () => {
      const candidates = [
        createCandidate(1n, 80_000n), // profit: 20_000
        createCandidate(2n, 200_000n), // profit: 140_000 (1st)
        createCandidate(3n, 120_000n), // profit: 60_000 (3rd)
        createCandidate(4n, 160_000n), // profit: 100_000 (2nd)
      ];
      const config = createConfig();
      const maxTasksPerRound = 3;

      const ranked = rankCandidatesByProfit(candidates, config);
      const selected = selectTopCandidates(ranked, maxTasksPerRound);

      // Should select in order: 140k, 100k, 60k
      expect(selected).toHaveLength(3);
      expect(selected[0]!.taskId).toBe(2n);
      expect(selected[1]!.taskId).toBe(4n);
      expect(selected[2]!.taskId).toBe(3n);
    });

    it("does not select low-profit candidates when budget exhausted", () => {
      const candidates = [
        createCandidate(1n, 100_000n), // profit: 40_000
        createCandidate(2n, 500_000n), // profit: 440_000
        createCandidate(3n, 150_000n), // profit: 90_000
      ];
      const config = createConfig();
      const maxTasksPerRound = 1; // Only 1 slot

      const ranked = rankCandidatesByProfit(candidates, config);
      const selected = selectTopCandidates(ranked, maxTasksPerRound);

      // Should select only the highest profit task
      expect(selected).toHaveLength(1);
      expect(selected[0]!.taskId).toBe(2n); // 440_000

      // Verify lower-profit tasks are excluded
      const selectedIds = selected.map((c) => c.taskId);
      expect(selectedIds).not.toContain(1n);
      expect(selectedIds).not.toContain(3n);
    });
  });

  describe("arrival order independence", () => {
    it("selects same candidates regardless of arrival order", () => {
      const config = createConfig();
      const maxTasksPerRound = 2;

      // Scenario A: candidates arrive high profit → low profit
      const arrivalA = [
        createCandidate(2n, 500_000n), // High profit first
        createCandidate(5n, 300_000n),
        createCandidate(1n, 100_000n),
        createCandidate(3n, 150_000n),
        createCandidate(4n, 75_000n),
      ];

      // Scenario B: candidates arrive low profit → high profit (reversed)
      const arrivalB = [
        createCandidate(4n, 75_000n), // Low profit first
        createCandidate(3n, 150_000n),
        createCandidate(1n, 100_000n),
        createCandidate(5n, 300_000n),
        createCandidate(2n, 500_000n), // High profit last
      ];

      const rankedA = rankCandidatesByProfit(arrivalA, config);
      const rankedB = rankCandidatesByProfit(arrivalB, config);

      const selectedA = selectTopCandidates(rankedA, maxTasksPerRound);
      const selectedB = selectTopCandidates(rankedB, maxTasksPerRound);

      // Both should select identical tasks
      expect(selectedA.map((c) => c.taskId)).toEqual(selectedB.map((c) => c.taskId));
      expect(selectedA[0]!.taskId).toBe(2n);
      expect(selectedA[1]!.taskId).toBe(5n);
      expect(selectedB[0]!.taskId).toBe(2n);
      expect(selectedB[1]!.taskId).toBe(5n);
    });

    it("produces same selection after removing and re-adding candidates", () => {
      const config = createConfig();
      const maxTasksPerRound = 2;

      const candidatesV1 = [
        createCandidate(1n, 100_000n),
        createCandidate(2n, 500_000n),
        createCandidate(3n, 150_000n),
      ];

      const candidatesV2 = [
        createCandidate(1n, 100_000n),
        createCandidate(3n, 150_000n),
        createCandidate(2n, 500_000n), // Re-added in different position
      ];

      const rankedV1 = rankCandidatesByProfit(candidatesV1, config);
      const rankedV2 = rankCandidatesByProfit(candidatesV2, config);

      const selectedV1 = selectTopCandidates(rankedV1, maxTasksPerRound);
      const selectedV2 = selectTopCandidates(rankedV2, maxTasksPerRound);

      expect(selectedV1.map((c) => c.taskId)).toEqual(selectedV2.map((c) => c.taskId));
    });
  });

  describe("edge cases for round budget", () => {
    it("handles round budget of 1", () => {
      const candidates = [
        createCandidate(1n, 100_000n), // profit: 40_000
        createCandidate(2n, 500_000n), // profit: 440_000
        createCandidate(3n, 150_000n), // profit: 90_000
      ];
      const config = createConfig();

      const ranked = rankCandidatesByProfit(candidates, config);
      const selected = selectTopCandidates(ranked, 1);

      expect(selected).toHaveLength(1);
      expect(selected[0]!.taskId).toBe(2n); // Highest profit
    });

    it("handles round budget equal to candidate count", () => {
      const candidates = [
        createCandidate(1n, 100_000n),
        createCandidate(2n, 500_000n),
        createCandidate(3n, 150_000n),
      ];
      const config = createConfig();

      const ranked = rankCandidatesByProfit(candidates, config);
      const selected = selectTopCandidates(ranked, candidates.length);

      // Should select all candidates
      expect(selected).toHaveLength(3);
    });

    it("handles round budget greater than candidate count", () => {
      const candidates = [
        createCandidate(1n, 100_000n),
        createCandidate(2n, 500_000n),
      ];
      const config = createConfig();

      const ranked = rankCandidatesByProfit(candidates, config);
      const selected = selectTopCandidates(ranked, 100); // Budget >> candidates

      // Should select all available candidates
      expect(selected).toHaveLength(2);
    });

    it("handles round budget of 0", () => {
      const candidates = [
        createCandidate(1n, 100_000n),
        createCandidate(2n, 500_000n),
      ];
      const config = createConfig();

      const ranked = rankCandidatesByProfit(candidates, config);
      const selected = selectTopCandidates(ranked, 0);

      expect(selected).toHaveLength(0);
    });
  });

  describe("profitability mix scenarios", () => {
    it("prioritizes profitable over unprofitable candidates", () => {
      const candidates = [
        createCandidate(1n, 100_000n), // profit: 40_000 (profitable)
        createCandidate(2n, 30_000n), // profit: -30_000 (unprofitable)
        createCandidate(3n, 200_000n), // profit: 140_000 (profitable)
      ];
      const config = createConfig();

      const ranked = rankCandidatesByProfit(candidates, config);
      const selected = selectTopCandidates(ranked, 2);

      // Should select the two profitable ones (in profit order)
      expect(selected[0]!.taskId).toBe(3n); // 140_000
      expect(selected[1]!.taskId).toBe(1n); // 40_000
    });

    it("handles scenario with many candidates and small budget", () => {
      const candidates = Array.from({ length: 100 }, (_, i) =>
        createCandidate(BigInt(i + 1), BigInt(100_000 * (i + 1)))
      );
      const config = createConfig();
      const maxTasksPerRound = 5;

      const ranked = rankCandidatesByProfit(candidates, config);
      const selected = selectTopCandidates(ranked, maxTasksPerRound);

      // Should select exactly 5
      expect(selected).toHaveLength(5);

      // Should be the highest profit 5 (last 5 in array, in descending order)
      expect(selected[0]!.taskId).toBe(100n);
      expect(selected[1]!.taskId).toBe(99n);
      expect(selected[2]!.taskId).toBe(98n);
      expect(selected[3]!.taskId).toBe(97n);
      expect(selected[4]!.taskId).toBe(96n);
    });
  });

  describe("verifies acceptance criteria", () => {
    it("AC#1: candidates are ranked before processing", () => {
      const candidates = [
        createCandidate(3n, 100_000n),
        createCandidate(1n, 500_000n),
        createCandidate(2n, 150_000n),
      ];
      const config = createConfig();

      // Step 1: Rank candidates
      const ranked = rankCandidatesByProfit(candidates, config);

      // Verify ranking happened (order changed from input)
      const inputOrder = candidates.map((c) => c.taskId);
      const rankedOrder = ranked.map((c) => c.taskId);

      expect(inputOrder).not.toEqual(rankedOrder);
      expect(rankedOrder).toEqual([1n, 2n, 3n]); // Ranked by profit descending
    });

    it("AC#2: round processes most profitable candidates first when budget limited", () => {
      const candidates = [
        createCandidate(1n, 100_000n),
        createCandidate(2n, 500_000n),
        createCandidate(3n, 150_000n),
        createCandidate(4n, 75_000n),
        createCandidate(5n, 300_000n),
      ];
      const config = createConfig();
      const maxTasksPerRound = 2; // Cannot process all

      const ranked = rankCandidatesByProfit(candidates, config);
      const selected = selectTopCandidates(ranked, maxTasksPerRound);

      // Verify most profitable are selected
      const selectedIds = selected.map((c) => c.taskId);
      expect(selectedIds).toEqual([2n, 5n]); // 500k and 300k rewards

      // Verify lower-profit candidates not selected
      expect(selectedIds).not.toContain(1n); // 100k
      expect(selectedIds).not.toContain(3n); // 150k
      expect(selectedIds).not.toContain(4n); // 75k
    });
  });
});
