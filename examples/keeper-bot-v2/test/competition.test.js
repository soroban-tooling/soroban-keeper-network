"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const { runKeeperRound, isLostClaimRaceError } = require("../src/loop.js");
const { MetricsCollector } = require("../src/metrics.js");

describe("Simulated multi-keeper competition test harness (Issue #404)", () => {
  it("correctly identifies lost claim race errors", () => {
    assert.strictEqual(
      isLostClaimRaceError(new Error("Task 12 already claimed by another keeper")),
      true
    );
    assert.strictEqual(
      isLostClaimRaceError(new Error("HostError: Error(Contract, #2)")),
      true
    );
    assert.strictEqual(
      isLostClaimRaceError(new Error("TaskAlreadyClaimed")),
      true
    );
    assert.strictEqual(
      isLostClaimRaceError(new Error("task not pending: already claimed")),
      true
    );
    assert.strictEqual(
      isLostClaimRaceError(new Error("Connection refused: 500")),
      false
    );
    assert.strictEqual(
      isLostClaimRaceError(new Error("RPC timeout")),
      false
    );
  });

  it("handles lost claim race as success-with-skip without logging or counting as error", async () => {
    const errorLogs = [];
    const regularLogs = [];
    const logger = {
      log: (msg) => regularLogs.push(msg),
      warn: (msg) => regularLogs.push(msg),
      error: (msg) => errorLogs.push(msg),
    };

    const metrics = new MetricsCollector();

    // Client where task 2 is already claimed by a phantom competitor mid-round
    const client = {
      claims: [],
      executions: [],
      claimTask: async (taskId) => {
        if (taskId === 2n) {
          throw new Error("Task 2 already claimed by another keeper (Contract Error #2)");
        }
        client.claims.push(taskId);
        return { status: "SUCCESS" };
      },
      executeTask: async (taskId, proof) => {
        client.executions.push({ taskId, proof });
        return { status: "SUCCESS" };
      },
    };

    const candidates = [
      { taskId: 1n, reward: 500_000n, taskType: 4, taskTypeName: "TtlExtension" },
      { taskId: 2n, reward: 400_000n, taskType: 4, taskTypeName: "TtlExtension" },
      { taskId: 3n, reward: 300_000n, taskType: 4, taskTypeName: "TtlExtension" },
    ];

    const summary = await runKeeperRound({
      client,
      candidateTasks: candidates,
      maxConcurrency: 1, // Sequential to verify continuation
      metrics,
      logger,
    });

    // 1. Lost claim race is observably handled as success-with-skip:
    // summary.errors must be empty!
    assert.strictEqual(
      summary.errors.length,
      0,
      `Expected 0 errors, got: ${JSON.stringify(summary.errors.map((e) => e.message))}`
    );

    // 2. Not logged as an error: errorLogs must NOT contain the lost race
    assert.strictEqual(
      errorLogs.length,
      0,
      `Expected no error logs, got: ${JSON.stringify(errorLogs)}`
    );

    // Instead, logged as normal competition skip
    assert.ok(
      regularLogs.some((l) => l.includes("[COMPETITION] Task 2 already claimed by competitor")),
      "Did not log normal competition notice"
    );

    // 3. Bot continues processing remaining candidates in the same round:
    // Task 1 and Task 3 are both claimed and executed!
    assert.deepStrictEqual(client.claims, [1n, 3n]);
    assert.strictEqual(summary.claimed, 2);
    assert.strictEqual(summary.executed, 2);
    assert.strictEqual(summary.skipped, 1);

    // 4. Metrics correctly distinguish a lost race from other skip reasons
    const snapshot = metrics.getSnapshot();
    assert.strictEqual(snapshot.round.skipsByReason.lost_claim_race, 1);
    assert.strictEqual(snapshot.cumulative.lostClaimRaces, 1);
    assert.strictEqual(snapshot.round.errors.length, 0);
  });

  it("simulates multi-keeper competition where two bots contend for shared tasks", async () => {
    // Shared on-chain state simulated across two concurrent bots
    const taskRegistry = new Map([
      [101n, { claimedBy: null, executed: false }],
      [102n, { claimedBy: null, executed: false }],
      [103n, { claimedBy: null, executed: false }],
    ]);

    function makeKeeperClient(keeperName) {
      return {
        claims: [],
        executions: [],
        claimTask: async (taskId) => {
          const t = taskRegistry.get(taskId);
          if (!t) throw new Error("TaskNotFound");
          if (t.claimedBy !== null) {
            throw new Error(`Task ${taskId} already claimed by ${t.claimedBy} (TaskAlreadyClaimed)`);
          }
          t.claimedBy = keeperName;
          return { status: "SUCCESS" };
        },
        executeTask: async (taskId, _proof) => {
          const t = taskRegistry.get(taskId);
          t.executed = true;
          return { status: "SUCCESS" };
        },
      };
    }

    const clientA = makeKeeperClient("KeeperA");
    const clientB = makeKeeperClient("KeeperB");

    const metricsA = new MetricsCollector();
    const metricsB = new MetricsCollector();

    const candidates = [
      { taskId: 101n, reward: 600_000n, taskType: 4, taskTypeName: "TtlExtension" },
      { taskId: 102n, reward: 500_000n, taskType: 4, taskTypeName: "TtlExtension" },
      { taskId: 103n, reward: 400_000n, taskType: 4, taskTypeName: "TtlExtension" },
    ];

    // Run both bots competing concurrently against the same task set
    const [summaryA, summaryB] = await Promise.all([
      runKeeperRound({
        client: clientA,
        candidateTasks: candidates,
        maxConcurrency: 2,
        metrics: metricsA,
        logger: { log: () => {}, warn: () => {}, error: () => {} },
      }),
      runKeeperRound({
        client: clientB,
        candidateTasks: candidates,
        maxConcurrency: 2,
        metrics: metricsB,
        logger: { log: () => {}, warn: () => {}, error: () => {} },
      }),
    ]);

    // Neither bot should record unhandled errors
    assert.strictEqual(summaryA.errors.length, 0);
    assert.strictEqual(summaryB.errors.length, 0);

    // All 3 tasks must have been claimed and executed between the two bots
    const totalExecuted = summaryA.executed + summaryB.executed;
    assert.strictEqual(totalExecuted, 3);

    // Total skips across both bots should equal 3 (each lost race counted as skip)
    const totalLostRaces =
      (metricsA.getSnapshot().round.skipsByReason.lost_claim_race || 0) +
      (metricsB.getSnapshot().round.skipsByReason.lost_claim_race || 0);
    assert.strictEqual(totalLostRaces, 3);
  });
});
