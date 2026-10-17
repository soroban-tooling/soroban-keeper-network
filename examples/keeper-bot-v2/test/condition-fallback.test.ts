/**
 * Tests for condition evaluation fallback (issue #665)
 *
 * Verifies:
 * 1. Fallback handler detects prediction-simulation disagreements
 * 2. Disagreements are logged with detailed context
 * 3. Retry logic with exponential backoff recovers from transient failures
 * 4. Statistics tracking provides observability
 */

import { describe, it, beforeEach } from "vitest";
import assert from "node:assert";
import type { EvaluatedCandidate } from "../src/types.js";
import {
  ConditionFallbackHandler,
  ConditionFallbackRetry,
  decideFinalConditionStatus,
  DEFAULT_FALLBACK_RETRY_POLICY,
} from "../src/condition-fallback.js";

describe("Condition Evaluation Fallback (Issue #665)", () => {
  describe("ConditionFallbackHandler — Disagreement tracking and logging", () => {
    it("detects agreement between prediction and simulation", async () => {
      const logs: string[] = [];
      const handler = new ConditionFallbackHandler((msg) => logs.push(msg));

      const candidate: EvaluatedCandidate = {
        taskId: 1n,
        taskType: 0,
        taskTypeName: "oracle_update",
        calldata: Buffer.from([]),
        reward: 1000n,
        deadline: Math.floor(Date.now() / 1000) + 3600,
        verifier: null,
      };

      const simulateFn = async (): Promise<boolean> => true;

      const result = await handler.evaluateWithFallback(candidate, true, simulateFn);

      assert.strictEqual(result.taskId, 1n);
      assert.strictEqual(result.predictedMet, true);
      assert.strictEqual(result.simulatedMet, true);
      assert.strictEqual(result.agreed, true);
      assert.strictEqual(result.shouldAttempt, true);

      // No disagreement log when they match
      const disagreementLogs = logs.filter((m) => m.includes("DISAGREEMENT"));
      assert.strictEqual(disagreementLogs.length, 0);
    });

    it("detects disagreement when predicted true but simulated false", async () => {
      const logs: string[] = [];
      const handler = new ConditionFallbackHandler((msg) => logs.push(msg));

      const candidate: EvaluatedCandidate = {
        taskId: 2n,
        taskType: 0,
        taskTypeName: "oracle_update",
        calldata: Buffer.from([]),
        reward: 1000n,
        deadline: Math.floor(Date.now() / 1000) + 3600,
        verifier: null,
      };

      const simulateFn = async (): Promise<boolean> => false;

      const result = await handler.evaluateWithFallback(candidate, true, simulateFn);

      assert.strictEqual(result.predictedMet, true);
      assert.strictEqual(result.simulatedMet, false);
      assert.strictEqual(result.agreed, false);
      assert.strictEqual(result.shouldAttempt, false); // Uses simulated result

      // Should log disagreement
      const disagreementLogs = logs.filter((m) => m.includes("DISAGREEMENT"));
      assert.strictEqual(disagreementLogs.length, 1);
      assert.ok(disagreementLogs[0]!.includes("Task 2"));
      assert.ok(disagreementLogs[0]!.includes("Predicted=true"));
      assert.ok(disagreementLogs[0]!.includes("simulation result=false"));
    });

    it("detects disagreement when predicted false but simulated true", async () => {
      const logs: string[] = [];
      const handler = new ConditionFallbackHandler((msg) => logs.push(msg));

      const candidate: EvaluatedCandidate = {
        taskId: 3n,
        taskType: 0,
        taskTypeName: "oracle_update",
        calldata: Buffer.from([]),
        reward: 1000n,
        deadline: Math.floor(Date.now() / 1000) + 3600,
        verifier: null,
      };

      const simulateFn = async (): Promise<boolean> => true;

      const result = await handler.evaluateWithFallback(candidate, false, simulateFn);

      assert.strictEqual(result.predictedMet, false);
      assert.strictEqual(result.simulatedMet, true);
      assert.strictEqual(result.agreed, false);
      assert.strictEqual(result.shouldAttempt, true); // Uses simulated result

      const disagreementLogs = logs.filter((m) => m.includes("DISAGREEMENT"));
      assert.strictEqual(disagreementLogs.length, 1);
    });

    it("tracks simulation time for each evaluation", async () => {
      const handler = new ConditionFallbackHandler();

      const candidate: EvaluatedCandidate = {
        taskId: 4n,
        taskType: 0,
        taskTypeName: "oracle_update",
        calldata: Buffer.from([]),
        reward: 1000n,
        deadline: Math.floor(Date.now() / 1000) + 3600,
        verifier: null,
      };

      const simulateFn = async (): Promise<boolean> => {
        // Simulate a 10ms operation
        await new Promise((resolve) => setTimeout(resolve, 10));
        return true;
      };

      await handler.evaluateWithFallback(candidate, true, simulateFn);
      const stats = handler.getStats();

      assert.strictEqual(stats.totalChecked, 1);
      assert.ok(stats.averageSimulationTimeMs >= 10);
    });

    it("handles simulation failures with fallback to prediction", async () => {
      const logs: string[] = [];
      const handler = new ConditionFallbackHandler((msg) => logs.push(msg));

      const candidate: EvaluatedCandidate = {
        taskId: 5n,
        taskType: 0,
        taskTypeName: "oracle_update",
        calldata: Buffer.from([]),
        reward: 1000n,
        deadline: Math.floor(Date.now() / 1000) + 3600,
        verifier: null,
      };

      const simulateFn = async (): Promise<boolean> => {
        throw new Error("RPC connection timeout");
      };

      const result = await handler.evaluateWithFallback(candidate, true, simulateFn);

      // On error, falls back to prediction
      assert.strictEqual(result.shouldAttempt, true);
      assert.ok(result.reason);

      const errorLogs = logs.filter((m) => m.includes("SIMULATION ERROR"));
      assert.ok(errorLogs.length > 0);
      assert.ok(errorLogs[0]!.includes("RPC connection timeout"));
    });

    it("batch-evaluates multiple tasks with fallback", async () => {
      const handler = new ConditionFallbackHandler();

      const candidates: EvaluatedCandidate[] = [
        {
          taskId: 1n,
          taskType: 0,
          taskTypeName: "oracle_update",
          calldata: Buffer.from([]),
          reward: 1000n,
          deadline: Math.floor(Date.now() / 1000) + 3600,
          verifier: null,
        },
        {
          taskId: 2n,
          taskType: 0,
          taskTypeName: "oracle_update",
          calldata: Buffer.from([]),
          reward: 1000n,
          deadline: Math.floor(Date.now() / 1000) + 3600,
          verifier: null,
        },
      ];

      const predictedMet = new Map([
        [1n, true],
        [2n, false],
      ]);

      const simulateFn = async (taskId: bigint): Promise<boolean> => {
        // Task 1: prediction true, simulation false (disagreement)
        // Task 2: prediction false, simulation false (agreement)
        return taskId === 2n ? false : false;
      };

      const results = await handler.evaluateBatchWithFallback(candidates, predictedMet, simulateFn);

      assert.strictEqual(results.length, 2);
      assert.strictEqual(results[0]!.taskId, 1n);
      assert.strictEqual(results[1]!.taskId, 2n);
    });

    it("provides disagreement statistics", async () => {
      const handler = new ConditionFallbackHandler();

      const candidate1: EvaluatedCandidate = {
        taskId: 1n,
        taskType: 0,
        taskTypeName: "oracle_update",
        calldata: Buffer.from([]),
        reward: 1000n,
        deadline: Math.floor(Date.now() / 1000) + 3600,
        verifier: null,
      };

      const candidate2: EvaluatedCandidate = {
        taskId: 2n,
        taskType: 0,
        taskTypeName: "oracle_update",
        calldata: Buffer.from([]),
        reward: 1000n,
        deadline: Math.floor(Date.now() / 1000) + 3600,
        verifier: null,
      };

      // First evaluation: predicted true, simulated false
      await handler.evaluateWithFallback(candidate1, true, async () => false);

      // Second evaluation: predicted false, simulated true
      await handler.evaluateWithFallback(candidate2, false, async () => true);

      const stats = handler.getStats();

      assert.strictEqual(stats.totalChecked, 2);
      assert.strictEqual(stats.totalDisagreements, 2);
      assert.strictEqual(stats.predictedMetButSimulatedUnmet, 1);
      assert.strictEqual(stats.predictedUnmetButSimulatedMet, 1);
    });

    it("logs summary statistics", async () => {
      const logs: string[] = [];
      const handler = new ConditionFallbackHandler((msg) => logs.push(msg));

      const candidate: EvaluatedCandidate = {
        taskId: 1n,
        taskType: 0,
        taskTypeName: "oracle_update",
        calldata: Buffer.from([]),
        reward: 1000n,
        deadline: Math.floor(Date.now() / 1000) + 3600,
        verifier: null,
      };

      await handler.evaluateWithFallback(candidate, true, async () => false);
      handler.logStats();

      const summaryLogs = logs.filter((m) => m.includes("FALLBACK SUMMARY"));
      assert.ok(summaryLogs.length > 0);
      assert.ok(summaryLogs[0]!.includes("1 disagreement"));
    });

    it("resets state for next round", async () => {
      const handler = new ConditionFallbackHandler();

      const candidate: EvaluatedCandidate = {
        taskId: 1n,
        taskType: 0,
        taskTypeName: "oracle_update",
        calldata: Buffer.from([]),
        reward: 1000n,
        deadline: Math.floor(Date.now() / 1000) + 3600,
        verifier: null,
      };

      await handler.evaluateWithFallback(candidate, true, async () => false);

      let stats = handler.getStats();
      assert.strictEqual(stats.totalDisagreements, 1);

      handler.reset();

      stats = handler.getStats();
      assert.strictEqual(stats.totalChecked, 0);
      assert.strictEqual(stats.totalDisagreements, 0);
    });
  });

  describe("ConditionFallbackRetry — Exponential backoff for resilient simulations", () => {
    it("executes function successfully on first attempt", async () => {
      const retry = new ConditionFallbackRetry();
      const calls: number[] = [];

      const fn = async () => {
        calls.push(Date.now());
        return true;
      };

      const result = await retry.executeWithRetry(fn);

      assert.strictEqual(result, true);
      assert.strictEqual(calls.length, 1);
    });

    it("retries on failure with exponential backoff", async () => {
      const policy = {
        maxRetries: 2,
        initialDelayMs: 10,
        maxDelayMs: 100,
        backoffMultiplier: 2,
      };
      const retry = new ConditionFallbackRetry(policy);

      let attempts = 0;
      const fn = async () => {
        attempts++;
        if (attempts < 3) {
          throw new Error("Temporary failure");
        }
        return true;
      };

      const result = await retry.executeWithRetry(fn);

      assert.strictEqual(result, true);
      assert.strictEqual(attempts, 3);
    });

    it("fails after max retries exceeded", async () => {
      const policy = {
        maxRetries: 1,
        initialDelayMs: 1,
        maxDelayMs: 100,
        backoffMultiplier: 2,
      };
      const retry = new ConditionFallbackRetry(policy);

      let attempts = 0;
      const fn = async () => {
        attempts++;
        throw new Error("Persistent failure");
      };

      try {
        await retry.executeWithRetry(fn);
        assert.fail("Should have thrown");
      } catch (err: unknown) {
        assert.ok(err instanceof Error);
        assert.ok(err.message.includes("Persistent failure"));
        assert.strictEqual(attempts, 2); // initial + 1 retry
      }
    });

    it("uses default retry policy when not specified", async () => {
      const retry = new ConditionFallbackRetry();
      assert.deepStrictEqual(
        retry["policy"],
        DEFAULT_FALLBACK_RETRY_POLICY
      );
    });
  });

  describe("Decision logic — Combining prediction and simulation", () => {
    it("prefers simulation when available", () => {
      const decision = decideFinalConditionStatus(true, false, true);
      assert.strictEqual(decision, false); // Uses simulation result (false)
    });

    it("uses prediction when simulation unavailable", () => {
      const decision = decideFinalConditionStatus(true, null, true);
      assert.strictEqual(decision, true); // Falls back to prediction
    });

    it("can disable simulation preference if needed", () => {
      const decision = decideFinalConditionStatus(true, false, false);
      assert.strictEqual(decision, true); // Uses prediction despite simulation available
    });

    it("handles all combinations correctly", () => {
      assert.strictEqual(decideFinalConditionStatus(true, true, true), true);
      assert.strictEqual(decideFinalConditionStatus(true, false, true), false);
      assert.strictEqual(decideFinalConditionStatus(false, true, true), true);
      assert.strictEqual(decideFinalConditionStatus(false, false, true), false);
      assert.strictEqual(decideFinalConditionStatus(true, null, true), true);
      assert.strictEqual(decideFinalConditionStatus(false, null, true), false);
    });
  });
});
