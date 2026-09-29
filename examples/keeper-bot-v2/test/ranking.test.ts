/**
 * Candidate ranking tests (issue #0261)
 *
 * Critical acceptance tests for task prioritization by expected net profit:
 * - Candidates are ranked before processing, not in arrival order
 * - Most profitable candidates are processed first when budget limited
 * - Ranking order is deterministic
 * - Round budget constraints are respected
 */

import { describe, it, expect } from "vitest";
import {
  rankCandidatesByProfit,
  selectTopCandidates,
  partitionByProfitability,
  getCandidateRankingStats,
} from "../src/ranking.js";
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

describe("ranking", () => {
  describe("rankCandidatesByProfit", () => {
    it("ranks candidates by descending net profit", () => {
      // Create candidates with distinct rewards
      const candidates = [
        createCandidate(1n, 100_000n), // profit: 40_000
        createCandidate(2n, 200_000n), // profit: 140_000
        createCandidate(3n, 150_000n), // profit: 90_000
      ];
      const config = createConfig();

      const ranked = rankCandidatesByProfit(candidates, config);

      // Expect descending order: 200k > 150k > 100k
      expect(ranked[0]!.taskId).toBe(2n);
      expect(ranked[1]!.taskId).toBe(3n);
      expect(ranked[2]!.taskId).toBe(1n);
    });

    it("accepts candidates in arrival order and reorders by profit", () => {
      // Simulate arrival order (low to high profit)
      const candidates = [
        createCandidate(1n, 100_000n), // Low profit: 40_000
        createCandidate(2n, 150_000n), // Mid profit: 90_000
        createCandidate(3n, 200_000n), // High profit: 140_000
      ];
      const config = createConfig();

      const ranked = rankCandidatesByProfit(candidates, config);

      // Output should be reversed (highest profit first)
      expect(ranked[0]!.taskId).toBe(3n);
      expect(ranked[1]!.taskId).toBe(2n);
      expect(ranked[2]!.taskId).toBe(1n);
    });

    it("uses task ID as stable tiebreaker for equal profit", () => {
      // All candidates have the same reward, so same profit
      const candidates = [
        createCandidate(10n, 100_000n),
        createCandidate(5n, 100_000n),
        createCandidate(3n, 100_000n),
        createCandidate(8n, 100_000n),
      ];
      const config = createConfig();

      const ranked = rankCandidatesByProfit(candidates, config);

      // Should be sorted by taskId ascending (stable order for ties)
      expect(ranked[0]!.taskId).toBe(3n);
      expect(ranked[1]!.taskId).toBe(5n);
      expect(ranked[2]!.taskId).toBe(8n);
      expect(ranked[3]!.taskId).toBe(10n);
    });

    it("includes profit metadata in ranked candidates", () => {
      const candidates = [createCandidate(1n, 100_000n)];
      const config = createConfig();

      const ranked = rankCandidatesByProfit(candidates, config);

      expect(ranked[0]!.expectedNetProfit).toBe(40_000n);
      expect(ranked[0]!.estimatedFee).toBe(60_000n);
      expect(ranked[0]!.profitable).toBe(true);
    });

    it("handles mixed profitable and unprofitable candidates", () => {
      const candidates = [
        createCandidate(1n, 100_000n), // Profitable: 40_000
        createCandidate(2n, 30_000n), // Unprofitable: -30_000
        createCandidate(3n, 150_000n), // Profitable: 90_000
      ];
      const config = createConfig();

      const ranked = rankCandidatesByProfit(candidates, config);

      // Ranked from high to low profit (unprofitable candidates still ranked)
      expect(ranked[0]!.taskId).toBe(3n); // 90_000
      expect(ranked[1]!.taskId).toBe(1n); // 40_000
      expect(ranked[2]!.taskId).toBe(2n); // -30_000
    });

    it("handles empty candidate list", () => {
      const ranked = rankCandidatesByProfit([], createConfig());
      expect(ranked).toHaveLength(0);
    });

    it("handles single candidate", () => {
      const candidates = [createCandidate(1n, 100_000n)];
      const ranked = rankCandidatesByProfit(candidates, createConfig());

      expect(ranked).toHaveLength(1);
      expect(ranked[0]!.taskId).toBe(1n);
    });
  });

  describe("selectTopCandidates", () => {
    it("selects N top candidates from ranked list", () => {
      const ranked = [
        createCandidate(1n, 100_000n),
        createCandidate(2n, 200_000n),
        createCandidate(3n, 150_000n),
      ].map((c) => ({
        ...c,
        expectedNetProfit: 0n,
        estimatedFee: 0n,
        profitable: true,
      }));

      const selected = selectTopCandidates(ranked, 2);

      expect(selected).toHaveLength(2);
      expect(selected[0]!.taskId).toBe(1n);
      expect(selected[1]!.taskId).toBe(2n);
    });

    it("respects budget limit when fewer candidates than budget", () => {
      const ranked = [
        createCandidate(1n, 100_000n),
        createCandidate(2n, 200_000n),
      ].map((c) => ({
        ...c,
        expectedNetProfit: 0n,
        estimatedFee: 0n,
        profitable: true,
      }));

      const selected = selectTopCandidates(ranked, 10);

      expect(selected).toHaveLength(2);
    });

    it("returns empty array when budget is 0", () => {
      const ranked = [
        createCandidate(1n, 100_000n),
        createCandidate(2n, 200_000n),
      ].map((c) => ({
        ...c,
        expectedNetProfit: 0n,
        estimatedFee: 0n,
        profitable: true,
      }));

      const selected = selectTopCandidates(ranked, 0);

      expect(selected).toHaveLength(0);
    });

    it("preserves order of ranked candidates", () => {
      const ranked = [
        createCandidate(1n, 100_000n),
        createCandidate(2n, 200_000n),
        createCandidate(3n, 150_000n),
      ].map((c) => ({
        ...c,
        expectedNetProfit: 0n,
        estimatedFee: 0n,
        profitable: true,
      }));

      const selected = selectTopCandidates(ranked, 3);

      expect(selected[0]!.taskId).toBe(1n);
      expect(selected[1]!.taskId).toBe(2n);
      expect(selected[2]!.taskId).toBe(3n);
    });
  });

  describe("partitionByProfitability", () => {
    it("separates profitable from unprofitable candidates", () => {
      const ranked = [
        { ...createCandidate(1n, 100_000n), profitable: true, expectedNetProfit: 40_000n, estimatedFee: 60_000n },
        { ...createCandidate(2n, 30_000n), profitable: false, expectedNetProfit: -30_000n, estimatedFee: 60_000n },
        { ...createCandidate(3n, 150_000n), profitable: true, expectedNetProfit: 90_000n, estimatedFee: 60_000n },
      ];

      const { profitable, unprofitable } = partitionByProfitability(ranked);

      expect(profitable).toHaveLength(2);
      expect(unprofitable).toHaveLength(1);
      expect(profitable[0]!.taskId).toBe(1n);
      expect(profitable[1]!.taskId).toBe(3n);
      expect(unprofitable[0]!.taskId).toBe(2n);
    });

    it("preserves original order within each partition", () => {
      const ranked = [
        { ...createCandidate(1n, 100_000n), profitable: true, expectedNetProfit: 40_000n, estimatedFee: 60_000n },
        { ...createCandidate(2n, 150_000n), profitable: true, expectedNetProfit: 90_000n, estimatedFee: 60_000n },
        { ...createCandidate(3n, 30_000n), profitable: false, expectedNetProfit: -30_000n, estimatedFee: 60_000n },
      ];

      const { profitable, unprofitable } = partitionByProfitability(ranked);

      expect(profitable[0]!.taskId).toBe(1n);
      expect(profitable[1]!.taskId).toBe(2n);
      expect(unprofitable[0]!.taskId).toBe(3n);
    });
  });

  describe("getCandidateRankingStats", () => {
    it("calculates ranking statistics correctly", () => {
      const ranked = [
        { ...createCandidate(1n, 100_000n), profitable: true, expectedNetProfit: 40_000n, estimatedFee: 60_000n },
        { ...createCandidate(2n, 200_000n), profitable: true, expectedNetProfit: 140_000n, estimatedFee: 60_000n },
        { ...createCandidate(3n, 30_000n), profitable: false, expectedNetProfit: -30_000n, estimatedFee: 60_000n },
      ];

      const stats = getCandidateRankingStats(ranked, 2);

      expect(stats.totalCandidates).toBe(3);
      expect(stats.totalProfitable).toBe(2);
      expect(stats.selectedCount).toBe(2);
      expect(stats.topRankProfit).toBe(40_000n);
      expect(stats.bottomRankProfit).toBe(-30_000n);
      expect(stats.deferred).toBe(1);
    });

    it("calculates average profit correctly", () => {
      const ranked = [
        { ...createCandidate(1n, 100_000n), profitable: true, expectedNetProfit: 40_000n, estimatedFee: 60_000n },
        { ...createCandidate(2n, 200_000n), profitable: true, expectedNetProfit: 140_000n, estimatedFee: 60_000n },
        { ...createCandidate(3n, 30_000n), profitable: false, expectedNetProfit: -30_000n, estimatedFee: 60_000n },
      ];

      const stats = getCandidateRankingStats(ranked, 2);

      // Average: (40_000 + 140_000 - 30_000) / 3 = 150_000 / 3 = 50_000
      expect(stats.averageProfit).toBe(50_000n);
    });

    it("handles empty candidate list", () => {
      const stats = getCandidateRankingStats([], 0);

      expect(stats.totalCandidates).toBe(0);
      expect(stats.topRankProfit).toBeNull();
      expect(stats.bottomRankProfit).toBeNull();
      expect(stats.averageProfit).toBe(0n);
      expect(stats.deferred).toBe(0);
    });
  });

  describe("determinism", () => {
    it("produces identical ranking on repeated calls", () => {
      const candidates = [
        createCandidate(3n, 100_000n),
        createCandidate(1n, 200_000n),
        createCandidate(2n, 150_000n),
      ];
      const config = createConfig();

      const ranked1 = rankCandidatesByProfit(candidates, config);
      const ranked2 = rankCandidatesByProfit(candidates, config);
      const ranked3 = rankCandidatesByProfit(candidates, config);

      expect(ranked1).toEqual(ranked2);
      expect(ranked2).toEqual(ranked3);
    });

    it("produces identical ranking regardless of input order", () => {
      const config = createConfig();

      const order1 = [
        createCandidate(1n, 100_000n),
        createCandidate(2n, 200_000n),
        createCandidate(3n, 150_000n),
      ];

      const order2 = [
        createCandidate(3n, 150_000n),
        createCandidate(1n, 100_000n),
        createCandidate(2n, 200_000n),
      ];

      const ranked1 = rankCandidatesByProfit(order1, config);
      const ranked2 = rankCandidatesByProfit(order2, config);

      // Should produce same output regardless of input order
      expect(ranked1.map((c) => c.taskId)).toEqual(ranked2.map((c) => c.taskId));
    });
  });
});
