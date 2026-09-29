/**
 * Ranking determinism tests (issue #0261)
 *
 * Validates that ranking and selection produce deterministic, reproducible
 * results, ensuring consistent behavior across runs and network conditions.
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

describe("ranking determinism", () => {
  describe("ranking is deterministic on repeated calls", () => {
    it("produces identical ranking on consecutive calls", () => {
      const candidates = [
        createCandidate(3n, 100_000n),
        createCandidate(1n, 500_000n),
        createCandidate(2n, 150_000n),
      ];
      const config = createConfig();

      const ranked1 = rankCandidatesByProfit(candidates, config);
      const ranked2 = rankCandidatesByProfit(candidates, config);
      const ranked3 = rankCandidatesByProfit(candidates, config);

      expect(ranked1).toEqual(ranked2);
      expect(ranked2).toEqual(ranked3);
    });

    it("produces identical ranking across multiple runs", () => {
      const candidates = [
        createCandidate(1n, 100_000n),
        createCandidate(2n, 200_000n),
        createCandidate(3n, 150_000n),
        createCandidate(4n, 75_000n),
        createCandidate(5n, 300_000n),
      ];
      const config = createConfig();

      // Run 10 times
      const rankings = Array.from({ length: 10 }, () =>
        rankCandidatesByProfit(candidates, config).map((c) => c.taskId)
      );

      // All rankings should be identical
      const firstRanking = rankings[0]!;
      for (let i = 1; i < rankings.length; i++) {
        expect(rankings[i]).toEqual(firstRanking);
      }
    });
  });

  describe("selection is deterministic on repeated calls", () => {
    it("produces identical selection on consecutive calls", () => {
      const candidates = [
        createCandidate(1n, 100_000n),
        createCandidate(2n, 500_000n),
        createCandidate(3n, 150_000n),
      ];
      const config = createConfig();

      const ranked = rankCandidatesByProfit(candidates, config);

      const selected1 = selectTopCandidates(ranked, 2);
      const selected2 = selectTopCandidates(ranked, 2);
      const selected3 = selectTopCandidates(ranked, 2);

      expect(selected1).toEqual(selected2);
      expect(selected2).toEqual(selected3);
    });

    it("produces identical selection across multiple runs", () => {
      const candidates = [
        createCandidate(1n, 100_000n),
        createCandidate(2n, 500_000n),
        createCandidate(3n, 150_000n),
        createCandidate(4n, 75_000n),
        createCandidate(5n, 300_000n),
      ];
      const config = createConfig();

      const selections = Array.from({ length: 10 }, () => {
        const ranked = rankCandidatesByProfit(candidates, config);
        return selectTopCandidates(ranked, 2).map((c) => c.taskId);
      });

      const firstSelection = selections[0]!;
      for (let i = 1; i < selections.length; i++) {
        expect(selections[i]).toEqual(firstSelection);
      }
    });
  });

  describe("determinism with edge cases", () => {
    it("deterministic ranking with identical rewards", () => {
      const candidates = [
        createCandidate(10n, 100_000n),
        createCandidate(5n, 100_000n),
        createCandidate(3n, 100_000n),
        createCandidate(8n, 100_000n),
      ];
      const config = createConfig();

      const ranked1 = rankCandidatesByProfit(candidates, config);
      const ranked2 = rankCandidatesByProfit(candidates, config);

      // Should consistently sort by taskId when profit is identical
      expect(ranked1.map((c) => c.taskId)).toEqual([3n, 5n, 8n, 10n]);
      expect(ranked2.map((c) => c.taskId)).toEqual([3n, 5n, 8n, 10n]);
    });

    it("deterministic ranking with single candidate", () => {
      const candidates = [createCandidate(1n, 100_000n)];
      const config = createConfig();

      const rankings = Array.from({ length: 5 }, () =>
        rankCandidatesByProfit(candidates, config).map((c) => c.taskId)
      );

      // All should be identical trivial ranking
      expect(rankings[0]).toEqual([1n]);
      expect(rankings).toEqual([[1n], [1n], [1n], [1n], [1n]]);
    });

    it("deterministic ranking with empty list", () => {
      const config = createConfig();

      const rankings = Array.from({ length: 5 }, () =>
        rankCandidatesByProfit([], config).map((c) => c.taskId)
      );

      // All should be empty
      expect(rankings[0]).toEqual([]);
      expect(rankings).toEqual([[], [], [], [], []]);
    });

    it("deterministic with very large rewards", () => {
      const candidates = [
        createCandidate(1n, 1_000_000_000_000n), // 1 trillion stroops
        createCandidate(2n, 2_000_000_000_000n),
        createCandidate(3n, 500_000_000_000n),
      ];
      const config = createConfig();

      const ranked1 = rankCandidatesByProfit(candidates, config);
      const ranked2 = rankCandidatesByProfit(candidates, config);

      expect(ranked1.map((c) => c.taskId)).toEqual(ranked2.map((c) => c.taskId));
    });

    it("deterministic with very small positive rewards", () => {
      const candidates = [
        createCandidate(1n, 100n),
        createCandidate(2n, 1_000n),
        createCandidate(3n, 10_000n),
      ];
      const config = createConfig();

      const ranked1 = rankCandidatesByProfit(candidates, config);
      const ranked2 = rankCandidatesByProfit(candidates, config);

      expect(ranked1.map((c) => c.taskId)).toEqual(ranked2.map((c) => c.taskId));
    });

    it("deterministic with negative profits", () => {
      const candidates = [
        createCandidate(1n, 10_000n), // profit: -50_000
        createCandidate(2n, 30_000n), // profit: -30_000
        createCandidate(3n, 50_000n), // profit: -10_000
      ];
      const config = createConfig();

      const ranked1 = rankCandidatesByProfit(candidates, config);
      const ranked2 = rankCandidatesByProfit(candidates, config);

      // Should be sorted by profit descending (least negative first)
      expect(ranked1.map((c) => c.taskId)).toEqual([3n, 2n, 1n]);
      expect(ranked2.map((c) => c.taskId)).toEqual([3n, 2n, 1n]);
    });
  });

  describe("determinism under tie-breaking", () => {
    it("stable tie-breaking with identical profit", () => {
      const candidates = [
        createCandidate(100n, 100_000n),
        createCandidate(10n, 100_000n),
        createCandidate(1n, 100_000n),
        createCandidate(50n, 100_000n),
      ];
      const config = createConfig();

      const ranked1 = rankCandidatesByProfit(candidates, config);
      const ranked2 = rankCandidatesByProfit(candidates, config);

      // Should consistently tie-break by taskId
      expect(ranked1.map((c) => c.taskId)).toEqual([1n, 10n, 50n, 100n]);
      expect(ranked2.map((c) => c.taskId)).toEqual([1n, 10n, 50n, 100n]);
    });

    it("consistent tie-breaking with multiple identical reward groups", () => {
      const candidates = [
        createCandidate(1n, 100_000n),
        createCandidate(2n, 100_000n),
        createCandidate(3n, 200_000n),
        createCandidate(4n, 200_000n),
        createCandidate(5n, 150_000n),
      ];
      const config = createConfig();

      const ranked1 = rankCandidatesByProfit(candidates, config);
      const ranked2 = rankCandidatesByProfit(candidates, config);

      // Expected order: 200k (3,4), 150k (5), 100k (1,2)
      const order1 = ranked1.map((c) => c.taskId);
      const order2 = ranked2.map((c) => c.taskId);

      expect(order1[0]).toBe(3n); // 200_000, lower taskId
      expect(order1[1]).toBe(4n); // 200_000, higher taskId
      expect(order1[2]).toBe(5n); // 150_000
      expect(order1[3]).toBe(1n); // 100_000, lower taskId
      expect(order1[4]).toBe(2n); // 100_000, higher taskId

      expect(order2).toEqual(order1);
    });
  });

  describe("determinism of complete workflow", () => {
    it("complete ranking + selection workflow is deterministic", () => {
      const candidates = [
        createCandidate(1n, 100_000n),
        createCandidate(2n, 500_000n),
        createCandidate(3n, 150_000n),
        createCandidate(4n, 75_000n),
        createCandidate(5n, 300_000n),
      ];
      const config = createConfig();
      const maxTasksPerRound = 2;

      // Run complete workflow multiple times
      const results = Array.from({ length: 5 }, () => {
        const ranked = rankCandidatesByProfit(candidates, config);
        const selected = selectTopCandidates(ranked, maxTasksPerRound);
        return selected.map((c) => ({ taskId: c.taskId, profit: c.expectedNetProfit }));
      });

      // All results should be identical
      const firstResult = results[0]!;
      for (let i = 1; i < results.length; i++) {
        expect(results[i]).toEqual(firstResult);
      }

      // Verify the results are correct
      expect(firstResult[0]!.taskId).toBe(2n);
      expect(firstResult[1]!.taskId).toBe(5n);
    });

    it("deterministic across different profitability configs", () => {
      const candidates = [
        createCandidate(1n, 100_000n),
        createCandidate(2n, 500_000n),
        createCandidate(3n, 150_000n),
      ];

      const config1: ProfitabilityConfig = {
        minProfitMarginStroops: 0n,
        estimatedClaimFeeStroops: 10_000n,
        estimatedExecuteBaseFeeStroops: 50_000n,
      };

      const config2: ProfitabilityConfig = {
        minProfitMarginStroops: 0n,
        estimatedClaimFeeStroops: 10_000n,
        estimatedExecuteBaseFeeStroops: 50_000n,
      };

      // Same config values = same ranking
      const ranked1 = rankCandidatesByProfit(candidates, config1);
      const ranked2 = rankCandidatesByProfit(candidates, config2);

      expect(ranked1.map((c) => c.taskId)).toEqual(ranked2.map((c) => c.taskId));
    });
  });
});
