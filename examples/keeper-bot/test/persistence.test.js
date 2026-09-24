import assert from "node:assert";
import test from "node:test";

/**
 * Persistence and Restart Recovery Tests for Keeper Bot V2
 *
 * Tests that verify:
 * - Task state survives process restart
 * - Restarted bot does not re-claim or re-execute completed tasks
 * - Mid-round restart recovery maintains consistency
 * - In-flight state is properly recovered
 * - Terminal states persist across restarts
 */

/**
 * Simulated persistent state store
 * Same implementation as concurrency.test.js for consistency
 */
class PersistentStateStore {
  constructor() {
    this.tasks = new Map();
    this.locks = new Map();
    this.roundStarted = null;
    this.roundCompleted = null;
  }

  async claimTask(taskId, workerId) {
    await this._ensureSerialAccess(taskId);
    const task = this.tasks.get(taskId);

    if (!task) {
      this.tasks.set(taskId, {
        status: "ClaimInProgress",
        ownerId: workerId,
        claimedAt: Date.now(),
        outcome: null,
      });
      return true;
    }

    if (task.status !== "Pending") {
      return false;
    }

    task.status = "ClaimInProgress";
    task.ownerId = workerId;
    task.claimedAt = Date.now();
    return true;
  }

  async markClaimSubmitted(taskId, transactionHash) {
    await this._ensureSerialAccess(taskId);
    const task = this.tasks.get(taskId);
    if (task && task.status === "ClaimInProgress") {
      task.status = "Claimed";
      task.claimTxHash = transactionHash;
      task.claimedOnChainAt = Date.now();
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
      task.executionStartedAt = Date.now();
      return true;
    }
    return false;
  }

  async markExecuted(taskId, transactionHash, outcome = "success") {
    await this._ensureSerialAccess(taskId);
    const task = this.tasks.get(taskId);
    if (task && task.status === "ExecutionInProgress") {
      task.status = "Executed";
      task.executeTxHash = transactionHash;
      task.executedAt = Date.now();
      task.outcome = outcome;
      return true;
    }
    return false;
  }

  async markFailed(taskId, reason) {
    await this._ensureSerialAccess(taskId);
    const task = this.tasks.get(taskId);
    if (task && task.status === "ExecutionInProgress") {
      task.status = "Failed";
      task.failureReason = reason;
      task.failedAt = Date.now();
      task.outcome = "failure";
      return true;
    }
    return false;
  }

  getTask(taskId) {
    return this.tasks.get(taskId);
  }

  getTasksByStatus(status) {
    return Array.from(this.tasks.values()).filter((t) => t.status === status);
  }

  initializePendingTasks(taskIds) {
    for (const taskId of taskIds) {
      this.tasks.set(taskId, {
        status: "Pending",
        ownerId: null,
        claimedAt: null,
        outcome: null,
      });
    }
  }

  /**
   * Simulate a process restart
   * - In-flight state (ClaimInProgress) is lost
   * - Partial persisted state (Claimed) is restored as Claimed
   * - ExecutionInProgress is reset to Claimed (ready for retry)
   * - Terminal states (Executed, Failed) are preserved
   */
  simulateRestart() {
    const restarted = new PersistentStateStore();

    for (const [taskId, task] of this.tasks) {
      if (task.status === "Executed" || task.status === "Failed") {
        // Terminal state: fully persisted, restored as-is
        restarted.tasks.set(taskId, { ...task });
      } else if (task.status === "Claimed") {
        // Claimed but not executed: ready for execution retry
        restarted.tasks.set(taskId, {
          ...task,
          status: "Claimed",
          executionOwnerId: null,
          executionStartedAt: null,
        });
      }
      // ClaimInProgress: lost on restart (not persisted)
      // Pending: lost if it was only in-memory
    }

    restarted.roundStarted = this.roundStarted;
    restarted.roundCompleted = this.roundCompleted;
    return restarted;
  }

  /**
   * Get a snapshot of the entire state for inspection
   */
  snapshot() {
    return {
      tasks: Array.from(this.tasks.entries()).map(([taskId, task]) => ({
        taskId,
        ...task,
      })),
      roundStarted: this.roundStarted,
      roundCompleted: this.roundCompleted,
    };
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
 * Simulated keeper bot runtime that manages a round of execution
 * Can be stopped mid-round and restarted
 */
class SimulatedKeeperRuntime {
  constructor(workerId, state) {
    this.workerId = workerId;
    this.state = state;
    this.processingTasks = [];
  }

  /**
   * Execute a round of task processing
   * Can be interrupted/cancelled
   */
  async executeRound(taskIds, { taskDelayMs = 10, canCancel = false } = {}) {
    this.state.roundStarted = Date.now();

    const results = [];

    for (const taskId of taskIds) {
      if (canCancel && results.length > Math.floor(taskIds.length / 2)) {
        // Simulate cancellation mid-round (for restart testing)
        break;
      }

      const result = await this._processTask(taskId, taskDelayMs);
      results.push(result);
    }

    this.state.roundCompleted = Date.now();
    return results;
  }

  /**
   * Process a single task: claim -> submit claim -> execute -> submit execute
   */
  async _processTask(taskId, delayMs = 10) {
    try {
      // Simulate processing delay
      if (delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }

      // Attempt claim
      const claimed = await this.state.claimTask(taskId, this.workerId);
      if (!claimed) {
        return { taskId, success: false, reason: "already_claimed" };
      }

      // Mark claim submitted
      await this.state.markClaimSubmitted(
        taskId,
        `claim-tx-${this.workerId}-${taskId}`
      );

      // Start execution
      const canExecute = await this.state.startExecution(taskId, this.workerId);
      if (!canExecute) {
        return {
          taskId,
          success: false,
          reason: "cannot_start_execution",
        };
      }

      // Mark executed
      await this.state.markExecuted(
        taskId,
        `exec-tx-${this.workerId}-${taskId}`,
        "success"
      );

      return { taskId, success: true, type: "fully_executed" };
    } catch (err) {
      await this.state.markFailed(taskId, err.message);
      return { taskId, success: false, reason: "exception", error: err };
    }
  }
}

test("persistence: executed task survives single restart", async () => {
  const state1 = new PersistentStateStore();
  state1.initializePendingTasks(["task-1"]);

  // First runtime: claim and execute task
  const runtime1 = new SimulatedKeeperRuntime("keeper-1", state1);
  const results1 = await runtime1.executeRound(["task-1"]);

  assert.strictEqual(results1[0].success, true, "Task should be executed");
  assert.strictEqual(
    state1.getTask("task-1").status,
    "Executed",
    "Task should be Executed"
  );

  // Simulate restart
  const state2 = state1.simulateRestart();

  // After restart, task should still be executed
  const restoredTask = state2.getTask("task-1");
  assert.strictEqual(
    restoredTask.status,
    "Executed",
    "Task should remain Executed after restart"
  );
  assert.strictEqual(
    restoredTask.outcome,
    "success",
    "Task outcome should be preserved"
  );
});

test("persistence: multiple executed tasks survive restart", async () => {
  const state1 = new PersistentStateStore();
  const taskIds = ["task-1", "task-2", "task-3"];
  state1.initializePendingTasks(taskIds);

  // Execute all tasks
  const runtime1 = new SimulatedKeeperRuntime("keeper-1", state1);
  const results1 = await runtime1.executeRound(taskIds, { taskDelayMs: 5 });

  // All should succeed
  results1.forEach((r) => {
    assert.strictEqual(r.success, true);
  });

  // Restart
  const state2 = state1.simulateRestart();

  // All should still be executed
  taskIds.forEach((taskId) => {
    const task = state2.getTask(taskId);
    assert.strictEqual(task.status, "Executed", `${taskId} should be Executed`);
  });
});

test("persistence: claimed but not executed recovers to claimed state", async () => {
  const state1 = new PersistentStateStore();
  state1.initializePendingTasks(["task-1"]);

  // Claim the task
  await state1.claimTask("task-1", "keeper-1");
  await state1.markClaimSubmitted("task-1", "claim-tx");

  // But don't execute (simulate early termination)
  assert.strictEqual(
    state1.getTask("task-1").status,
    "Claimed",
    "Task should be Claimed"
  );

  // Restart
  const state2 = state1.simulateRestart();

  // Task should still be Claimed, ready for execution
  const restoredTask = state2.getTask("task-1");
  assert.strictEqual(restoredTask.status, "Claimed", "Should remain Claimed");
  assert.strictEqual(
    restoredTask.executionOwnerId,
    null,
    "Execution ownership should be cleared"
  );
});

test("persistence: claim-in-progress is lost on restart", async () => {
  const state1 = new PersistentStateStore();
  state1.initializePendingTasks(["task-1"]);

  // Claim but don't submit
  const claimed = await state1.claimTask("task-1", "keeper-1");
  assert.strictEqual(claimed, true);
  assert.strictEqual(
    state1.getTask("task-1").status,
    "ClaimInProgress",
    "Task should be ClaimInProgress"
  );

  // Restart (ClaimInProgress not persisted)
  const state2 = state1.simulateRestart();

  // After restart, task should be gone from state
  // (In real system, it would be queried fresh from RPC)
  const restoredTask = state2.getTask("task-1");
  assert.strictEqual(restoredTask, undefined, "ClaimInProgress not persisted");
});

test("persistence: execution-in-progress resets to claimed on restart", async () => {
  const state1 = new PersistentStateStore();
  state1.initializePendingTasks(["task-1"]);

  // Claim, submit claim, start execution
  await state1.claimTask("task-1", "keeper-1");
  await state1.markClaimSubmitted("task-1", "claim-tx");
  await state1.startExecution("task-1", "keeper-1");

  assert.strictEqual(
    state1.getTask("task-1").status,
    "ExecutionInProgress",
    "Task should be ExecutionInProgress"
  );

  // Restart mid-execution
  const state2 = state1.simulateRestart();

  // Task should revert to Claimed, ready for re-execution
  const restoredTask = state2.getTask("task-1");
  assert.strictEqual(
    restoredTask.status,
    "Claimed",
    "Should reset to Claimed"
  );
  assert.strictEqual(
    restoredTask.executionOwnerId,
    null,
    "Execution ownership cleared"
  );
});

test("persistence: mid-round restart prevents double-claim", async () => {
  const state1 = new PersistentStateStore();
  const taskIds = ["task-1", "task-2", "task-3", "task-4"];
  state1.initializePendingTasks(taskIds);

  const runtime1 = new SimulatedKeeperRuntime("keeper-1", state1);

  // Start round but cancel mid-way (simulating process termination)
  const results1 = await runtime1.executeRound(taskIds, {
    taskDelayMs: 10,
    canCancel: true,
  });

  const executedBefore = results1.filter((r) => r.success).length;
  assert.ok(executedBefore > 0, "Some tasks executed before restart");
  assert.ok(executedBefore < taskIds.length, "But not all tasks");

  // Restart
  const state2 = state1.simulateRestart();
  const runtime2 = new SimulatedKeeperRuntime("keeper-1", state2);

  // Try to process the same tasks again
  const results2 = await runtime2.executeRound(taskIds, { taskDelayMs: 5 });

  // Count tasks that were already executed
  const stillExecutedCount = results2.filter(
    (r) => !r.success && r.reason === "already_claimed"
  ).length;

  assert.ok(
    stillExecutedCount > 0,
    "Previously executed tasks should be skipped"
  );
});

test("persistence: round metadata survives restart", async () => {
  const state1 = new PersistentStateStore();
  state1.initializePendingTasks(["task-1"]);

  const runtime1 = new SimulatedKeeperRuntime("keeper-1", state1);
  await runtime1.executeRound(["task-1"]);

  const roundStartBefore = state1.roundStarted;
  const roundCompleteBefore = state1.roundCompleted;

  assert.ok(roundStartBefore > 0, "Round start should be recorded");
  assert.ok(roundCompleteBefore >= roundStartBefore, "Round complete should be after start");

  // Restart
  const state2 = state1.simulateRestart();

  // Metadata should be preserved
  assert.strictEqual(
    state2.roundStarted,
    roundStartBefore,
    "Round start preserved"
  );
  assert.strictEqual(
    state2.roundCompleted,
    roundCompleteBefore,
    "Round complete preserved"
  );
});

test("persistence: failed task survives restart with failure reason", async () => {
  const state1 = new PersistentStateStore();
  state1.initializePendingTasks(["task-1"]);

  // Manually mark as failed
  await state1.claimTask("task-1", "keeper-1");
  await state1.markClaimSubmitted("task-1", "claim-tx");
  await state1.startExecution("task-1", "keeper-1");
  await state1.markFailed("task-1", "simulation_error");

  const failedTask = state1.getTask("task-1");
  assert.strictEqual(failedTask.status, "Failed", "Task should be Failed");
  assert.strictEqual(
    failedTask.failureReason,
    "simulation_error",
    "Failure reason recorded"
  );

  // Restart
  const state2 = state1.simulateRestart();

  // Failed task should still be failed
  const restoredFailed = state2.getTask("task-1");
  assert.strictEqual(restoredFailed.status, "Failed", "Should remain Failed");
  assert.strictEqual(
    restoredFailed.failureReason,
    "simulation_error",
    "Failure reason preserved"
  );
});

test("persistence: mixed task states survive restart correctly", async () => {
  const state1 = new PersistentStateStore();
  state1.initializePendingTasks([
    "pending-1",
    "claimed-1",
    "executed-1",
    "failed-1",
  ]);

  // Leave pending-1 as Pending
  // Move claimed-1 to Claimed
  await state1.claimTask("claimed-1", "keeper-1");
  await state1.markClaimSubmitted("claimed-1", "claim-tx");

  // Move executed-1 to Executed
  await state1.claimTask("executed-1", "keeper-1");
  await state1.markClaimSubmitted("executed-1", "claim-tx");
  await state1.startExecution("executed-1", "keeper-1");
  await state1.markExecuted("executed-1", "exec-tx");

  // Move failed-1 to Failed
  await state1.claimTask("failed-1", "keeper-1");
  await state1.markClaimSubmitted("failed-1", "claim-tx");
  await state1.startExecution("failed-1", "keeper-1");
  await state1.markFailed("failed-1", "some_error");

  // Restart
  const state2 = state1.simulateRestart();

  // Verify each task transitions correctly
  // Note: pending-1 and claim-in-progress are lost, so we don't check them
  const claimed = state2.getTask("claimed-1");
  assert.strictEqual(claimed.status, "Claimed", "claimed-1 stays Claimed");

  const executed = state2.getTask("executed-1");
  assert.strictEqual(executed.status, "Executed", "executed-1 stays Executed");

  const failed = state2.getTask("failed-1");
  assert.strictEqual(failed.status, "Failed", "failed-1 stays Failed");
});

test("persistence: multiple restarts maintain consistency", async () => {
  let state = new PersistentStateStore();
  state.initializePendingTasks(["task-1", "task-2"]);

  // Execute task-1 in first runtime
  const runtime1 = new SimulatedKeeperRuntime("keeper-1", state);
  await runtime1.executeRound(["task-1"], { taskDelayMs: 5 });

  // Restart and execute task-2
  state = state.simulateRestart();
  const runtime2 = new SimulatedKeeperRuntime("keeper-1", state);
  await runtime2.executeRound(["task-2"], { taskDelayMs: 5 });

  // Restart again
  state = state.simulateRestart();

  // Both should be executed
  assert.strictEqual(
    state.getTask("task-1").status,
    "Executed",
    "task-1 executed after 2 restarts"
  );
  assert.strictEqual(
    state.getTask("task-2").status,
    "Executed",
    "task-2 executed after 1 restart"
  );
});

test("persistence: snapshot captures complete state", async () => {
  const state1 = new PersistentStateStore();
  state1.initializePendingTasks(["task-1", "task-2", "task-3"]);

  const runtime1 = new SimulatedKeeperRuntime("keeper-1", state1);
  await runtime1.executeRound(["task-1", "task-2"]);

  const snapshot = state1.snapshot();

  assert.strictEqual(snapshot.tasks.length, 3, "Snapshot has 3 tasks");
  assert.ok(snapshot.roundStarted > 0, "Snapshot includes round start");
  assert.ok(snapshot.roundCompleted > 0, "Snapshot includes round complete");

  const executedCount = snapshot.tasks.filter(
    (t) => t.status === "Executed"
  ).length;
  assert.strictEqual(executedCount, 2, "Snapshot shows 2 executed tasks");
});
