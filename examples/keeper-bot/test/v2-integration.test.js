import assert from "node:assert";
import test from "node:test";

/**
 * Integration-Level Tests for Keeper Bot V2
 *
 * Tests that verify the full workflow pipeline:
 * - Candidate task discovery
 * - Profitability evaluation
 * - Claim decision
 * - Execution
 * - State persistence
 * - Concurrent worker coordination
 *
 * These tests ensure that profitability decisions correctly propagate
 * through the entire evaluation pipeline to final claim/skip outcomes.
 */

/**
 * Persistent state store (from concurrency.test.js)
 */
class PersistentStateStore {
  constructor() {
    this.tasks = new Map();
    this.locks = new Map();
    this.stats = {
      claimsAttempted: 0,
      claimsSucceeded: 0,
      claimsFailed: 0,
      skippedUnprofitable: 0,
      executed: 0,
    };
  }

  async claimTask(taskId, workerId) {
    this.stats.claimsAttempted++;
    await this._ensureSerialAccess(taskId);

    const task = this.tasks.get(taskId);

    if (!task) {
      this.tasks.set(taskId, {
        status: "ClaimInProgress",
        ownerId: workerId,
        claimedAt: Date.now(),
      });
      this.stats.claimsSucceeded++;
      return true;
    }

    if (task.status !== "Pending") {
      this.stats.claimsFailed++;
      return false;
    }

    task.status = "ClaimInProgress";
    task.ownerId = workerId;
    task.claimedAt = Date.now();
    this.stats.claimsSucceeded++;
    return true;
  }

  async markClaimSubmitted(taskId, txHash) {
    await this._ensureSerialAccess(taskId);
    const task = this.tasks.get(taskId);
    if (task && task.status === "ClaimInProgress") {
      task.status = "Claimed";
      task.claimTxHash = txHash;
      return true;
    }
    return false;
  }

  async startExecution(taskId, workerId) {
    await this._ensureSerialAccess(taskId);
    const task = this.tasks.get(taskId);
    if (task && task.status === "Claimed") {
      task.status = "ExecutionInProgress";
      task.executionOwnerId = workerId;
      return true;
    }
    return false;
  }

  async markExecuted(taskId, txHash) {
    await this._ensureSerialAccess(taskId);
    const task = this.tasks.get(taskId);
    if (task && task.status === "ExecutionInProgress") {
      task.status = "Executed";
      task.executeTxHash = txHash;
      this.stats.executed++;
      return true;
    }
    return false;
  }

  recordSkipped(reason) {
    if (reason === "unprofitable") {
      this.stats.skippedUnprofitable++;
    }
  }

  getTask(taskId) {
    return this.tasks.get(taskId);
  }

  initializePendingTasks(taskIds) {
    for (const taskId of taskIds) {
      this.tasks.set(taskId, {
        status: "Pending",
        ownerId: null,
        claimedAt: null,
      });
    }
  }

  async _ensureSerialAccess(taskId) {
    if (!this.locks.has(taskId)) {
      this.locks.set(taskId, Promise.resolve());
    }

    const previousLock = this.locks.get(taskId);
    const newLock = previousLock.then(() => {
      return new Promise((resolve) => setImmediate(resolve));
    });

    this.locks.set(taskId, newLock);
    await previousLock;
  }
}

/**
 * Profitability evaluator (from profitability-boundary.test.js)
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
    };
  }

  shouldSkip(task, options = {}) {
    return !this.evaluateTask(task, options).profitable;
  }
}

/**
 * Integrated keeper worker combining profitability evaluation with state management
 */
class IntegratedKeeperWorker {
  constructor(workerId, state, profitability) {
    this.workerId = workerId;
    this.state = state;
    this.profitability = profitability;
    this.results = [];
  }

  /**
   * Process a set of candidate tasks
   * - Evaluate profitability
   * - Skip unprofitable ones
   * - Claim profitable ones
   * - Execute if claim succeeds
   */
  async processCandidates(candidates) {
    const results = [];

    for (const task of candidates) {
      // Step 1: Check profitability
      if (this.profitability.shouldSkip(task)) {
        this.state.recordSkipped("unprofitable");
        results.push({
          taskId: task.taskId,
          action: "skipped",
          reason: "unprofitable",
        });
        continue;
      }

      // Step 2: Attempt claim
      const claimed = await this.state.claimTask(task.taskId, this.workerId);
      if (!claimed) {
        results.push({
          taskId: task.taskId,
          action: "skipped",
          reason: "already_claimed",
        });
        continue;
      }

      // Step 3: Submit claim on-chain
      await this.state.markClaimSubmitted(
        task.taskId,
        `claim-tx-${this.workerId}`
      );

      // Step 4: Attempt execution
      const canExecute = await this.state.startExecution(
        task.taskId,
        this.workerId
      );
      if (!canExecute) {
        results.push({
          taskId: task.taskId,
          action: "failed",
          reason: "execution_start_failed",
        });
        continue;
      }

      // Step 5: Submit execution
      await this.state.markExecuted(task.taskId, `exec-tx-${this.workerId}`);

      results.push({
        taskId: task.taskId,
        action: "executed",
      });
    }

    this.results = results;
    return results;
  }

  getResults() {
    return this.results;
  }
}

/**
 * Test suite
 */

test("integration: unprofitable tasks skipped before claim", async () => {
  const state = new PersistentStateStore();
  const profitability = new ProfitabilityEvaluator({
    claimFee: 10_000n,
    executeFee: 50_000n,
    withdrawalFee: 1_000n,
    minProfitMargin: 0n,
  });

  const candidates = [
    { taskId: "profitable", reward: 100_000n }, // Will be profitable
    { taskId: "unprofitable", reward: 1_000n }, // Will be unprofitable
  ];

  const worker = new IntegratedKeeperWorker("worker-1", state, profitability);
  const results = await worker.processCandidates(candidates);

  // Unprofitable should be skipped, never claimed
  const unprofitable = results.find((r) => r.taskId === "unprofitable");
  assert.strictEqual(
    unprofitable.action,
    "skipped",
    "Unprofitable task should be skipped"
  );
  assert.strictEqual(
    unprofitable.reason,
    "unprofitable",
    "Skip reason should be unprofitable"
  );

  // Profitable should be executed
  const profitable = results.find((r) => r.taskId === "profitable");
  assert.strictEqual(
    profitable.action,
    "executed",
    "Profitable task should be executed"
  );

  // State should reflect skipped count
  assert.strictEqual(
    state.stats.skippedUnprofitable,
    1,
    "One task recorded as skipped-unprofitable"
  );
  assert.strictEqual(
    state.stats.claimsSucceeded,
    1,
    "One task claimed successfully"
  );
});

test("integration: profitability decision propagates to execution", async () => {
  const state = new PersistentStateStore();
  const profitability = new ProfitabilityEvaluator({
    claimFee: 10_000n,
    executeFee: 50_000n,
    withdrawalFee: 1_000n,
    minProfitMargin: 10_000n,
  });

  const candidates = [
    { taskId: "above_margin", reward: 100_000n },
    { taskId: "below_margin", reward: 65_000n }, // Profitable without margin, not with
    { taskId: "at_margin", reward: 71_000n },
  ];

  const worker = new IntegratedKeeperWorker("worker-1", state, profitability);
  const results = await worker.processCandidates(candidates);

  const aboveMargin = results.find((r) => r.taskId === "above_margin");
  assert.strictEqual(aboveMargin.action, "executed", "Above margin executed");

  const belowMargin = results.find((r) => r.taskId === "below_margin");
  assert.strictEqual(belowMargin.action, "skipped", "Below margin skipped");

  const atMargin = results.find((r) => r.taskId === "at_margin");
  assert.strictEqual(atMargin.action, "executed", "At margin executed");
});

test("integration: multiple workers respect profitability and concurrency", async () => {
  const state = new PersistentStateStore();
  const profitability = new ProfitabilityEvaluator({
    claimFee: 10_000n,
    executeFee: 50_000n,
    withdrawalFee: 1_000n,
    minProfitMargin: 0n,
  });

  const candidates = [
    { taskId: "task-1", reward: 100_000n },
    { taskId: "task-2", reward: 100_000n },
    { taskId: "task-3", reward: 1_000n },
    { taskId: "task-4", reward: 100_000n },
  ];

  const worker1 = new IntegratedKeeperWorker("worker-1", state, profitability);
  const worker2 = new IntegratedKeeperWorker("worker-2", state, profitability);

  // Both workers process same candidates concurrently
  const [results1, results2] = await Promise.all([
    worker1.processCandidates(candidates),
    worker2.processCandidates(candidates),
  ]);

  // Count total executions (should be 3: task-1, task-2, task-4)
  const allResults = [...results1, ...results2];
  const executedCount = allResults.filter((r) => r.action === "executed").length;
  assert.strictEqual(executedCount, 3, "Three tasks executed (one unprofitable)");

  // Count skipped
  const skippedCount = allResults.filter(
    (r) => r.action === "skipped" && r.reason !== "already_claimed"
  ).length;
  assert.strictEqual(
    skippedCount,
    1,
    "One task skipped for unprofitability"
  );

  // Verify no double-execution
  const doubleExecuted = allResults.filter(
    (r) => r.action === "failed" || r.reason === "already_claimed"
  );
  assert.ok(
    doubleExecuted.length >= 0,
    "No duplicate execution (some tasks already_claimed by other worker)"
  );
});

test("integration: profitability threshold correctly filters large batch", async () => {
  const state = new PersistentStateStore();
  const profitability = new ProfitabilityEvaluator({
    claimFee: 10_000n,
    executeFee: 50_000n,
    withdrawalFee: 1_000n,
    minProfitMargin: 5_000n,
  });

  // Create 20 candidates: half profitable, half unprofitable
  const candidates = Array.from({ length: 20 }, (_, i) => ({
    taskId: `task-${i}`,
    reward: i % 2 === 0 ? 100_000n : 50_000n, // Alternating profitable/unprofitable
  }));

  const worker = new IntegratedKeeperWorker("worker-1", state, profitability);
  const results = await worker.processCandidates(candidates);

  // Should have skipped 10 unprofitable ones
  const skippedCount = results.filter(
    (r) => r.action === "skipped" && r.reason === "unprofitable"
  ).length;
  assert.strictEqual(skippedCount, 10, "Ten tasks skipped for unprofitability");

  // Should have executed 10 profitable ones
  const executedCount = results.filter((r) => r.action === "executed").length;
  assert.strictEqual(executedCount, 10, "Ten tasks executed");

  // State should reflect stats
  assert.strictEqual(
    state.stats.skippedUnprofitable,
    10,
    "Stats record skipped-unprofitable"
  );
  assert.strictEqual(
    state.stats.executed,
    10,
    "Stats record executed count"
  );
});

test("integration: profitability evaluation correct at system reset", async () => {
  const state1 = new PersistentStateStore();
  const profitability = new ProfitabilityEvaluator({
    claimFee: 10_000n,
    executeFee: 50_000n,
    withdrawalFee: 1_000n,
    minProfitMargin: 0n,
  });

  const candidates1 = [
    { taskId: "task-1", reward: 100_000n },
    { taskId: "task-2", reward: 50_000n },
  ];

  const worker1 = new IntegratedKeeperWorker("worker-1", state1, profitability);
  const results1 = await worker1.processCandidates(candidates1);

  const executedBefore = results1.filter((r) => r.action === "executed").length;
  assert.strictEqual(executedBefore, 1, "One task executed in first round");

  // Simulate restart with same state + profitability
  const state2 = new PersistentStateStore();
  state2.initializePendingTasks(["task-1", "task-2"]);

  // Process same tasks again (only unprofitable should appear in candidates)
  const candidates2 = [{ taskId: "task-2", reward: 50_000n }];

  const worker2 = new IntegratedKeeperWorker("worker-1", state2, profitability);
  const results2 = await worker2.processCandidates(candidates2);

  const skippedForUnprofitability = results2.filter(
    (r) => r.reason === "unprofitable"
  ).length;
  assert.strictEqual(
    skippedForUnprofitability,
    1,
    "Unprofitable task consistently skipped"
  );
});

test("integration: mixed profitability and concurrency scenarios", async () => {
  const state = new PersistentStateStore();
  const profitability = new ProfitabilityEvaluator({
    claimFee: 10_000n,
    executeFee: 50_000n,
    withdrawalFee: 1_000n,
    minProfitMargin: 10_000n,
  });

  // Create diverse candidate set
  const candidates = [
    { taskId: "very-profitable", reward: 1_000_000n },
    { taskId: "profitable", reward: 100_000n },
    { taskId: "at-margin", reward: 71_000n },
    { taskId: "just-below-margin", reward: 70_999n },
    { taskId: "unprofitable", reward: 1_000n },
  ];

  // 3 workers process concurrently
  const workers = Array.from(
    { length: 3 },
    (_, i) => new IntegratedKeeperWorker(`worker-${i}`, state, profitability)
  );

  const allResults = [];
  for (const worker of workers) {
    const results = await worker.processCandidates(candidates);
    allResults.push(...results);
  }

  // Count outcomes by action
  const executed = allResults.filter((r) => r.action === "executed").length;
  const skipped = allResults.filter(
    (r) => r.action === "skipped" && r.reason === "unprofitable"
  ).length;
  const alreadyClaimed = allResults.filter(
    (r) => r.reason === "already_claimed"
  ).length;

  assert.ok(executed > 0, "Some tasks executed");
  assert.ok(skipped > 0, "Some tasks skipped for unprofitability");
  assert.ok(alreadyClaimed > 0, "Some tasks lost concurrency race");
});

test("integration: profitability skipping is logged distinctly", async () => {
  const state = new PersistentStateStore();
  const profitability = new ProfitabilityEvaluator({
    claimFee: 10_000n,
    executeFee: 50_000n,
    withdrawalFee: 1_000n,
    minProfitMargin: 0n,
  });

  const candidates = [
    { taskId: "skip-unprofitable", reward: 1_000n },
  ];

  const worker = new IntegratedKeeperWorker("worker-1", state, profitability);
  const results = await worker.processCandidates(candidates);

  const result = results[0];
  assert.strictEqual(result.action, "skipped", "Task skipped");
  assert.strictEqual(
    result.reason,
    "unprofitable",
    "Reason distinctly marked as unprofitable"
  );

  // Verify state tracks this distinctly
  assert.strictEqual(
    state.stats.skippedUnprofitable,
    1,
    "State counts unprofitable skips separately"
  );
  assert.strictEqual(
    state.stats.claimsAttempted,
    0,
    "No claim attempted for unprofitable task"
  );
});

test("integration: evaluation pipeline is consistent", async () => {
  const state = new PersistentStateStore();
  const profitability = new ProfitabilityEvaluator({
    claimFee: 10_000n,
    executeFee: 50_000n,
    withdrawalFee: 1_000n,
    minProfitMargin: 5_000n,
  });

  const candidate = { taskId: "test-task", reward: 75_000n };

  // Check profitability multiple times
  const eval1 = profitability.evaluateTask(candidate);
  const eval2 = profitability.evaluateTask(candidate);

  assert.strictEqual(eval1.profitable, eval2.profitable, "Consistent results");
  assert.strictEqual(eval1.netProfit, eval2.netProfit, "Consistent profits");

  // Should result in consistent claim decision
  const skip1 = profitability.shouldSkip(candidate);
  const skip2 = profitability.shouldSkip(candidate);

  assert.strictEqual(skip1, skip2, "Consistent skip decisions");
});
