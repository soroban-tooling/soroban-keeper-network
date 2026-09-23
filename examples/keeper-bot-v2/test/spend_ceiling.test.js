"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const {
  runKeeperRound,
  ESTIMATED_CLAIM_FEE_STROOPS,
  ESTIMATED_EXECUTE_BASE_FEE_STROOPS,
} = require("../src/loop.js");
const { MetricsCollector } = require("../src/metrics.js");

function createMockClient() {
  const claims = [];
  const executions = [];

  return {
    claims,
    executions,
    claimTask: async (taskId) => {
      claims.push(taskId);
      return { status: "SUCCESS" };
    },
    executeTask: async (taskId, proof) => {
      executions.push({ taskId, proof });
      return { status: "SUCCESS" };
    },
  };
}

describe("Hard ceiling on per-round resource spend (Issue #407)", () => {
  it("stops submitting new transactions once the configured spend ceiling is reached, regardless of remaining candidates", async () => {
    const client = createMockClient();
    const metrics = new MetricsCollector();
    const warnings = [];
    const logger = {
      log: () => {},
      warn: (msg) => warnings.push(msg),
      error: () => {},
    };

    // Each task costs 10,000 (claim) + 50,000 (exec) = 60,000 stroops
    // If ceiling is 150,000 stroops:
    // Task 1: 60k (spend = 60k)
    // Task 2: 60k (spend = 120k)
    // Task 3: claim (10k) brings spend to 130k. Execute (50k) would bring spend to 180k > 150k!
    // So Task 3 execute is blocked, or subsequent claims/executes are halted.
    const tasks = [
      { taskId: 1n, reward: 200_000n, taskType: 4, taskTypeName: "TtlExtension" },
      { taskId: 2n, reward: 200_000n, taskType: 4, taskTypeName: "TtlExtension" },
      { taskId: 3n, reward: 200_000n, taskType: 4, taskTypeName: "TtlExtension" },
      { taskId: 4n, reward: 200_000n, taskType: 4, taskTypeName: "TtlExtension" },
      { taskId: 5n, reward: 200_000n, taskType: 4, taskTypeName: "TtlExtension" },
    ];

    const ceiling = 130_000n; // Exactly enough for 2 full tasks (120k) + 1 claim (10k), halting execute
    const summary = await runKeeperRound({
      client,
      candidateTasks: tasks,
      maxConcurrency: 1, // Sequential for deterministic ordering
      maxRoundSpendStroops: ceiling,
      metrics,
      logger,
    });

    assert.strictEqual(summary.ceilingReached, true);
    // Tasks 4 and 5 should never be attempted
    assert.ok(client.claims.length <= 3, `Expected <= 3 claims, got ${client.claims.length}`);
    assert.strictEqual(client.claims.includes(4n), false);
    assert.strictEqual(client.claims.includes(5n), false);

    // Total spend must not exceed ceiling
    assert.ok(
      summary.roundSpendStroops <= ceiling,
      `Spend ${summary.roundSpendStroops} exceeded ceiling ${ceiling}`
    );

    // Reaching the ceiling is logged distinctly
    assert.ok(
      warnings.some((w) => w.includes("[RESOURCE CEILING] Hard round spend ceiling reached")),
      "Did not emit distinct resource ceiling warning log"
    );

    // Metrics reflect ceiling hit and skipped tasks
    const snapshot = metrics.getSnapshot();
    assert.strictEqual(snapshot.round.spendCeilingReached, true);
    assert.ok(snapshot.round.skipsByReason.spend_ceiling_reached >= 2);
  });

  it("enforces ceiling as a hard backstop independent of profitability", async () => {
    const client = createMockClient();
    const metrics = new MetricsCollector();
    const warnings = [];
    const logger = {
      log: () => {},
      warn: (msg) => warnings.push(msg),
      error: () => {},
    };

    // Extremely lucrative task, huge net profit margin
    const lucrativeTask = {
      taskId: 100n,
      reward: 100_000_000n, // 10 XLM reward!
      taskType: 4,
      taskTypeName: "TtlExtension",
    };

    // Ceiling is set lower than the estimated claim fee
    const smallCeiling = 5_000n; // Claim requires 10,000 stroops

    const summary = await runKeeperRound({
      client,
      candidateTasks: [lucrativeTask],
      maxRoundSpendStroops: smallCeiling,
      metrics,
      logger,
    });

    // Even though it is astronomically profitable, the hard backstop must prevent submission
    assert.strictEqual(client.claims.length, 0);
    assert.strictEqual(summary.claimed, 0);
    assert.strictEqual(summary.ceilingReached, true);
    assert.strictEqual(summary.skipped, 1);
    assert.ok(warnings.some((w) => w.includes("[RESOURCE CEILING]")));
  });

  it("allows all tasks when spend ceiling is comfortably high", async () => {
    const client = createMockClient();
    const metrics = new MetricsCollector();
    const logger = { log: () => {}, warn: () => {}, error: () => {} };

    const tasks = [
      { taskId: 10n, reward: 200_000n, taskType: 4, taskTypeName: "TtlExtension" },
      { taskId: 20n, reward: 200_000n, taskType: 4, taskTypeName: "TtlExtension" },
    ];

    const summary = await runKeeperRound({
      client,
      candidateTasks: tasks,
      maxRoundSpendStroops: 5_000_000n,
      metrics,
      logger,
    });

    assert.strictEqual(summary.ceilingReached, false);
    assert.strictEqual(summary.claimed, 2);
    assert.strictEqual(summary.executed, 2);
    assert.strictEqual(
      summary.roundSpendStroops,
      2n * (ESTIMATED_CLAIM_FEE_STROOPS + ESTIMATED_EXECUTE_BASE_FEE_STROOPS)
    );
  });
});
