/**
 * Arrival order independence tests (issue #0261)
 *
 * Validates that the ranking and selection logic is not influenced
 * by the order in which candidates were discovered, ensuring consistent
 * results regardless of event arrival sequence.
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

describe("arrival order independence", () => {
  describe("ranking is independent of input order", () => {
    it("produces identical ranking for two different input orders", () => {
      const config = createConfig();

      // Same set of candidates, different arrival order
      const setA = [
        createCandidate(1n, 100_000n),
        createCandidate(2n, 200_000n),
        createCandidate(3n, 150_000n),
      ];

      const setB = [
        createCandidate(3n, 150_000n),
        createCandidate(1n, 100_000n),
        createCandidate(2n, 200_000n),
      ];

      const rankedA = rankCandidatesByProfit(setA, config);
      const rankedB = rankCandidatesByProfit(setB, config);

      // Output order should be identical
      expect(rankedA.map((c) => c.taskId)).toEqual(rankedB.map((c) => c.taskId));
    });

    it("produces consistent ranking across multiple permutations", () => {
      const config = createConfig();
      const taskIds = [1n, 2n, 3n, 4n, 5n];
      const rewards = [100_000n, 500_000n, 200_000n, 75_000n, 300_000n];

      // Create multiple different orderings
      const orderings = [
        [0, 1, 2, 3, 4],
        [4, 3, 2, 1, 0],
        [2, 0, 4, 1, 3],
        [3, 1, 4, 2, 0],
      ];

      const rankings = orderings.map((ordering) => {
        const candidates = ordering.map((i) => createCandidate(taskIds[i]!, rewards[i]!));
        const ranked = rankCandidatesByProfit(candidates, config);
        return ranked.map((c) => c.taskId);
      });

      // All rankings should be identical
      const firstRanking = rankings[0]!;
      for (let i = 1; i < rankings.length; i++) {
        expect(rankings[i]).toEqual(firstRanking);
      }
    });
  });

  describe("selection outcome is independent of input order", () => {
    it("selects same tasks regardless of discovery order", () => {
      const config = createConfig();
      const maxTasksPerRound = 3;

      // Discover tasks in different order
      const discoveryA = [
        createCandidate(1n, 100_000n),
        createCandidate(2n, 500_000n),
        createCandidate(3n, 150_000n),
        createCandidate(4n, 75_000n),
        createCandidate(5n, 300_000n),
      ];

      const discoveryB = [
        createCandidate(5n, 300_000n),
        createCandidate(2n, 500_000n),
        createCandidate(4n, 75_000n),
        createCandidate(1n, 100_000n),
        createCandidate(3n, 150_000n),
      ];

      const rankedA = rankCandidatesByProfit(discoveryA, config);
      const rankedB = rankCandidatesByProfit(discoveryB, config);

      const selectedA = selectTopCandidates(rankedA, maxTasksPerRound);
      const selectedB = selectTopCandidates(rankedB, maxTasksPerRound);

      // Should select identical tasks
      expect(selectedA.map((c) => c.taskId)).toEqual(selectedB.map((c) => c.taskId));

      // Verify they are the top 3 by profit: 2 (440k), 5 (240k), 3 (90k)
      expect(selectedA.map((c) => c.taskId)).toEqual([2n, 5n, 3n]);
      expect(selectedB.map((c) => c.taskId)).toEqual([2n, 5n, 3n]);
    });

    it("produces same selection after incremental candidate addition", () => {
      const config = createConfig();
      const maxTasksPerRound = 2;

      // Scenario 1: All candidates known upfront
      const allCandidates = [
        createCandidate(1n, 100_000n),
        createCandidate(2n, 500_000n),
        createCandidate(3n, 150_000n),
      ];

      // Scenario 2: Candidates added incrementally
      const incremental1 = [createCandidate(2n, 500_000n)];
      const incremental2 = [createCandidate(2n, 500_000n), createCandidate(1n, 100_000n)];
      const incremental3 = [
        createCandidate(2n, 500_000n),
        createCandidate(1n, 100_000n),
        createCandidate(3n, 150_000n),
      ];

      const rankedAll = rankCandidatesByProfit(allCandidates, config);
      const selectedAll = selectTopCandidates(rankedAll, maxTasksPerRound);

      // When all are known, final selection should match
      const rankedInc = rankCandidatesByProfit(incremental3, config);
      const selectedInc = selectTopCandidates(rankedInc, maxTasksPerRound);

      expect(selectedAll.map((c) => c.taskId)).toEqual(selectedInc.map((c) => c.taskId));
    });
  });

  describe("edge cases for order independence", () => {
    it("handles single-element list (trivial order independence)", () => {
      const config = createConfig();
      const candidate = createCandidate(1n, 100_000n);

      const ranked1 = rankCandidatesByProfit([candidate], config);
      const ranked2 = rankCandidatesByProfit([candidate], config);

      expect(ranked1[0]!.taskId).toBe(ranked2[0]!.taskId);
    });

    it("handles two-element list in both orders", () => {
      const config = createConfig();

      const orderA = [createCandidate(1n, 100_000n), createCandidate(2n, 200_000n)];
      const orderB = [createCandidate(2n, 200_000n), createCandidate(1n, 100_000n)];

      const rankedA = rankCandidatesByProfit(orderA, config);
      const rankedB = rankCandidatesByProfit(orderB, config);

      expect(rankedA.map((c) => c.taskId)).toEqual(rankedB.map((c) => c.taskId));
    });

    it("handles candidates with identical rewards in any order", () => {
      const config = createConfig();
      const identicalReward = 100_000n;

      const orderA = [
        createCandidate(3n, identicalReward),
        createCandidate(1n, identicalReward),
        createCandidate(2n, identicalReward),
      ];

      const orderB = [
        createCandidate(1n, identicalReward),
        createCandidate(2n, identicalReward),
        createCandidate(3n, identicalReward),
      ];

      const rankedA = rankCandidatesByProfit(orderA, config);
      const rankedB = rankCandidatesByProfit(orderB, config);

      // With identical profit, should be sorted by taskId
      expect(rankedA.map((c) => c.taskId)).toEqual([1n, 2n, 3n]);
      expect(rankedB.map((c) => c.taskId)).toEqual([1n, 2n, 3n]);
    });

    it("handles mixed profit values in random orders", () => {
      const config = createConfig();

      const orders = [
        [
          createCandidate(1n, 100_000n),
          createCandidate(2n, 500_000n),
          createCandidate(3n, 150_000n),
        ],
        [
          createCandidate(2n, 500_000n),
          createCandidate(3n, 150_000n),
          createCandidate(1n, 100_000n),
        ],
        [
          createCandidate(3n, 150_000n),
          createCandidate(1n, 100_000n),
          createCandidate(2n, 500_000n),
        ],
      ];

      const rankings = orders.map((order) => {
        const ranked = rankCandidatesByProfit(order, config);
        return ranked.map((c) => c.taskId);
      });

      // All rankings should be identical
      expect(rankings[0]).toEqual(rankings[1]);
      expect(rankings[1]).toEqual(rankings[2]);
    });
  });

  describe("arrival order does not affect profitability judgment", () => {
    it("profitable status independent of arrival order", () => {
      const config: ProfitabilityConfig = {
        minProfitMarginStroops: 30_000n,
        estimatedClaimFeeStroops: 10_000n,
        estimatedExecuteBaseFeeStroops: 50_000n,
      };

      const orderA = [
        createCandidate(1n, 100_000n), // profitable: 40_000 > 30_000
        createCandidate(2n, 50_000n), // unprofitable: -10_000 < 30_000
      ];

      const orderB = [
        createCandidate(2n, 50_000n),
        createCandidate(1n, 100_000n),
      ];

      const rankedA = rankCandidatesByProfit(orderA, config);
      const rankedB = rankCandidatesByProfit(orderB, config);

      // Find candidate 1 in each ranking
      const cand1InA = rankedA.find((c) => c.taskId === 1n);
      const cand1InB = rankedB.find((c) => c.taskId === 1n);

      expect(cand1InA!.profitable).toBe(cand1InB!.profitable);
      expect(cand1InA!.profitable).toBe(true);

      // Find candidate 2 in each ranking
      const cand2InA = rankedA.find((c) => c.taskId === 2n);
      const cand2InB = rankedB.find((c) => c.taskId === 2n);

      expect(cand2InA!.profitable).toBe(cand2InB!.profitable);
      expect(cand2InA!.profitable).toBe(false);
    });
  });

  describe("real-world scenario: competing keepers", () => {
    it("all keepers rank candidates identically regardless of network timing", () => {
      const config = createConfig();

      // Simulate network delays causing different discovery order
      const keeperADiscovery = [
        createCandidate(1n, 100_000n),
        createCandidate(2n, 500_000n),
        createCandidate(3n, 150_000n),
        createCandidate(4n, 75_000n),
        createCandidate(5n, 300_000n),
      ];

      const keeperBDiscovery = [
        createCandidate(5n, 300_000n),
        createCandidate(3n, 150_000n),
        createCandidate(1n, 100_000n),
        createCandidate(4n, 75_000n),
        createCandidate(2n, 500_000n),
      ];

      const keeperCDiscovery = [
        createCandidate(4n, 75_000n),
        createCandidate(2n, 500_000n),
        createCandidate(5n, 300_000n),
        createCandidate(3n, 150_000n),
        createCandidate(1n, 100_000n),
      ];

      const rankedA = rankCandidatesByProfit(keeperADiscovery, config);
      const rankedB = rankCandidatesByProfit(keeperBDiscovery, config);
      const rankedC = rankCandidatesByProfit(keeperCDiscovery, config);

      const rankingA = rankedA.map((c) => c.taskId);
      const rankingB = rankedB.map((c) => c.taskId);
      const rankingC = rankedC.map((c) => c.taskId);

      // All keepers should rank identically
      expect(rankingA).toEqual(rankingB);
      expect(rankingB).toEqual(rankingC);
    });
  });
});
