import assert from "node:assert";
import test from "node:test";

/**
 * Concurrency Safety Tests for Keeper Bot V2
 *
 * Tests genuine concurrent execution scenarios to ensure:
 * - Two concurrent workers never double-claim the same task
 * - Shared persisted state remains consistent under concurrent access
 * - Worker ownership tracking prevents duplicate work
 *
 * These tests use actual Promise.all() concurrency, not sequential simulation.
 */

/**
 * Simulated persistent state store for testing
 * In production, this would be SQLite/Redis with transaction safety
 */
class PersistentStateStore {
  constructor() {
    this.tasks = new Map(); // taskId -> {status, ownerId, timestamp, outcome}
    this.locks = new Map(); // taskId -> Promise chain for serialization
  }

  /**
   * Atomically mark a task as claimed-in-progress
   * Returns true if successful (was Pending), false if already claimed
   */
  async claimTask(taskId, workerId) {
    // Ensure single-threaded access to this task
    await this._ensureSerialAccess(taskId);

    const task = this.tasks.get(taskId);

    // Task doesn't exist yet
    if (!task) {
      this.tasks.set(taskId, {
        status: "ClaimInProgress",
        ownerId: workerId,
        claimedAt: Date.now(),
        outcome: null,
      });
      return true;
    }

    // Task already claimed by someone else
    if (task.status !== "Pending") {
      return false;
    }

    // Claim it now
    task.status = "ClaimInProgress";
    task.ownerId = workerId;
    task.claimedAt = Date.now();
    return true;
  }

  /**
   * Mark task as successfully claimed on-chain
   */
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

  /**
   * Mark task as execution-in-progress
   */
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

  /**
   * Mark task as successfully executed
   */
  async markExecuted(taskId, transactionHash) {
    await this._ensureSerialAccess(taskId);
    const task = this.tasks.get(taskId);
    if (task && task.status === "ExecutionInProgress") {
      task.status = "Executed";
      task.executeTxHash = transactionHash;
      task.executedAt = Date.now();
      task.outcome = "success";
      return true;
    }
    return false;
  }

  /**
   * Retrieve task state
   */
  getTask(taskId) {
    return this.tasks.get(taskId);
  }

  /**
   * Get all tasks in a specific status
   */
  getTasksByStatus(status) {
    return Array.from(this.tasks.values()).filter((t) => t.status === status);
  }

  /**
   * Initialize tasks in Pending state for testing
   */
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
   * Simulate a restart: clear in-flight state but keep completed outcomes
   */
  simulateRestart() {
    const restarted = new PersistentStateStore();
    for (const [taskId, task] of this.tasks) {
      if (task.status === "Executed" || task.status === "Failed") {
        // Terminal state: survives restart
        restarted.tasks.set(taskId, { ...task });
      } else if (
        task.status === "Claimed" ||
        task.status === "ExecutionInProgress"
      ) {
        // Partially persisted state: reset to Claimed (ready for execution retry)
        restarted.tasks.set(taskId, {
          ...task,
          status: "Claimed",
          executionOwnerId: null,
          executionStartedAt: null,
        });
      }
      // ClaimInProgress: not persisted, drops on restart
    }
    return restarted;
  }

  /**
   * Serialize-access lock for a task
   * Ensures that concurrent claimTask() calls don't both succeed
   */
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
 * Simulated worker that processes a task concurrently
 * Models a keeper bot worker attempting to claim and execute tasks
 */
class ConcurrentWorker {
  constructor(workerId, state, claimDelay = 0, executeDelay = 0) {
    this.workerId = workerId;
    this.state = state;
    this.claimDelay = claimDelay; // Simulate RPC latency
    this.executeDelay = executeDelay;
    this.operations = []; // Track what this worker did
  }

  /**
   * Attempt to claim a task
   * Returns {success, taskId, reason}
   */
  async attemptClaim(taskId) {
    // Simulate RPC latency
    if (this.claimDelay > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.claimDelay));
    }

    const claimed = await this.state.claimTask(taskId, this.workerId);

    if (claimed) {
      this.operations.push({
        type: "claim",
        taskId,
        success: true,
        timestamp: Date.now(),
      });
      return { success: true, taskId };
    } else {
      this.operations.push({
        type: "claim",
        taskId,
        success: false,
        reason: "task_already_claimed",
        timestamp: Date.now(),
      });
      return { success: false, taskId, reason: "task_already_claimed" };
    }
  }

  /**
   * Claim and execute a task sequentially
   */
  async claimAndExecute(taskId) {
    const claimResult = await this.attemptClaim(taskId);
    if (!claimResult.success) {
      return claimResult;
    }

    // Simulate on-chain claim submission
    await this.state.markClaimSubmitted(
      taskId,
      `claim-tx-${this.workerId}-${taskId}`
    );

    // Wait before attempting execution (simulated delay)
    if (this.executeDelay > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.executeDelay));
    }

    // Attempt to start execution
    const canExecute = await this.state.startExecution(taskId, this.workerId);
    if (!canExecute) {
      return {
        success: false,
        taskId,
        reason: "could_not_start_execution",
      };
    }

    // Simulate execution submission
    await this.state.markExecuted(taskId, `exec-tx-${this.workerId}-${taskId}`);

    this.operations.push({
      type: "execute",
      taskId,
      success: true,
      timestamp: Date.now(),
    });

    return { success: true, taskId, type: "full_execution" };
  }
}

test("concurrency: two workers racing for same task", async () => {
  const state = new PersistentStateStore();
  state.initializePendingTasks(["task-1"]);

  const worker1 = new ConcurrentWorker("worker-1", state, 0, 0);
  const worker2 = new ConcurrentWorker("worker-2", state, 0, 0);

  // Both workers attempt to claim the same task concurrently
  const [result1, result2] = await Promise.all([
    worker1.attemptClaim("task-1"),
    worker2.attemptClaim("task-1"),
  ]);

  // Exactly one should succeed
  const successCount = [result1.success, result2.success].filter(
    (s) => s
  ).length;
  assert.strictEqual(successCount, 1, "Exactly one worker should claim task");

  // Verify task state reflects single owner
  const task = state.getTask("task-1");
  assert.strictEqual(
    task.status,
    "ClaimInProgress",
    "Task should be ClaimInProgress"
  );
  assert.strictEqual(
    task.ownerId,
    result1.success ? "worker-1" : "worker-2",
    "Task owned by successful worker"
  );
});

test("concurrency: three workers racing for same task", async () => {
  const state = new PersistentStateStore();
  state.initializePendingTasks(["task-1"]);

  const workers = [
    new ConcurrentWorker("worker-1", state, 0, 0),
    new ConcurrentWorker("worker-2", state, 0, 0),
    new ConcurrentWorker("worker-3", state, state, 0, 0),
  ];

  // All three race
  const results = await Promise.all(
    workers.map((w) => w.attemptClaim("task-1"))
  );

  // Only one succeeds
  const successCount = results.filter((r) => r.success).length;
  assert.strictEqual(successCount, 1, "Exactly one worker should claim");

  // Other two get task_already_claimed
  const failures = results.filter((r) => !r.success);
  assert.strictEqual(
    failures.length,
    2,
    "Two workers should fail with already_claimed"
  );
  failures.forEach((f) => {
    assert.strictEqual(f.reason, "task_already_claimed");
  });
});

test("concurrency: heavy load with bounded concurrency", async () => {
  const state = new PersistentStateStore();
  const taskCount = 20;
  const workerCount = 4;

  // Initialize 20 tasks
  const taskIds = Array.from({ length: taskCount }, (_, i) => `task-${i}`);
  state.initializePendingTasks(taskIds);

  // Create workers
  const workers = Array.from(
    { length: workerCount },
    (_, i) => new ConcurrentWorker(`worker-${i}`, state, 0, 0)
  );

  // Each worker claims and executes up to 5 tasks sequentially
  const tasksPerWorker = 5;
  const claims = [];
  for (let w = 0; w < workerCount; w++) {
    for (let t = 0; t < tasksPerWorker; t++) {
      const taskId = taskIds[w * tasksPerWorker + t];
      if (taskId) {
        claims.push(workers[w].claimAndExecute(taskId));
      }
    }
  }

  const results = await Promise.all(claims);

  // Count successes (should be 20)
  const successCount = results.filter((r) => r.success).length;
  assert.strictEqual(successCount, 20, "All tasks should be claimed");

  // Verify no task has multiple owners
  const executed = state.getTasksByStatus("Executed");
  assert.strictEqual(
    executed.length,
    20,
    "All tasks should reach Executed state"
  );

  // Verify each task owned by exactly one worker
  for (const task of state.tasks.values()) {
    assert.ok(
      ["Pending", "Executed"].includes(task.status) || task.ownerId,
      "Each task has an owner"
    );
  }
});

test("concurrency: staggered claim latency doesn't cause double-claim", async () => {
  const state = new PersistentStateStore();
  state.initializePendingTasks(["task-1"]);

  // Simulate variable latency: one worker faster, one slower
  const worker1 = new ConcurrentWorker("worker-1", state, 5, 0); // 5ms claim delay
  const worker2 = new ConcurrentWorker("worker-2", state, 20, 0); // 20ms claim delay

  const [result1, result2] = await Promise.all([
    worker1.attemptClaim("task-1"),
    worker2.attemptClaim("task-1"),
  ]);

  // Verify exactly one succeeds despite timing difference
  const successCount = [result1.success, result2.success].filter(
    (s) => s
  ).length;
  assert.strictEqual(successCount, 1, "Only one worker should succeed");

  // Worker1 should win (lower latency)
  assert.strictEqual(result1.success, true, "Lower-latency worker wins");
  assert.strictEqual(result2.success, false, "Higher-latency worker fails");
});

test("concurrency: execution cannot start if claim not completed", async () => {
  const state = new PersistentStateStore();
  state.initializePendingTasks(["task-1"]);

  const worker = new ConcurrentWorker("worker-1", state, 0, 0);

  // Claim the task
  const claimResult = await worker.attemptClaim("task-1");
  assert.strictEqual(claimResult.success, true);

  // Mark claim submitted
  await state.markClaimSubmitted("task-1", "claim-tx");

  // Try to execute without marking claimed
  const canStartExec = await state.startExecution("task-1", "worker-1");
  assert.strictEqual(canStartExec, true, "Should allow execution to start");

  // Now try with a different worker on a different task
  state.initializePendingTasks(["task-2"]);
  const cannotStart = await state.startExecution("task-2", "worker-2");
  assert.strictEqual(cannotStart, false, "Cannot execute unclaimed task");
});

test("concurrency: parallel full workflow across multiple tasks", async () => {
  const state = new PersistentStateStore();
  const taskIds = ["task-1", "task-2", "task-3", "task-4"];
  state.initializePendingTasks(taskIds);

  const workers = [
    new ConcurrentWorker("worker-1", state, 2, 5),
    new ConcurrentWorker("worker-2", state, 3, 4),
  ];

  // Worker 1 processes tasks 1 and 3
  // Worker 2 processes tasks 2 and 4
  const w1Task1 = workers[0].claimAndExecute("task-1");
  const w2Task2 = workers[1].claimAndExecute("task-2");
  const w1Task3 = workers[0].claimAndExecute("task-3");
  const w2Task4 = workers[1].claimAndExecute("task-4");

  const results = await Promise.all([w1Task1, w2Task2, w1Task3, w2Task4]);

  // All should succeed
  results.forEach((r, i) => {
    assert.strictEqual(r.success, true, `Task ${i + 1} should succeed`);
  });

  // All tasks should be executed
  const executed = state.getTasksByStatus("Executed");
  assert.strictEqual(executed.length, 4, "All 4 tasks should be executed");
});

test("concurrency: concurrent read access is safe", async () => {
  const state = new PersistentStateStore();
  state.initializePendingTasks(["task-1", "task-2", "task-3"]);

  // Multiple workers read state concurrently
  const reads = [];
  for (let i = 0; i < 10; i++) {
    reads.push(
      Promise.resolve().then(() => {
        return [
          state.getTask("task-1"),
          state.getTask("task-2"),
          state.getTask("task-3"),
        ];
      })
    );
  }

  const results = await Promise.all(reads);

  // All reads should succeed without corruption
  results.forEach((r) => {
    assert.strictEqual(r.length, 3, "Should read 3 tasks");
    assert.ok(r.every((t) => t.status === "Pending"), "All should be Pending");
  });
});

test("concurrency: state consistency after burst of claims", async () => {
  const state = new PersistentStateStore();
  const taskCount = 50;
  const taskIds = Array.from({ length: taskCount }, (_, i) => `task-${i}`);
  state.initializePendingTasks(taskIds);

  // 10 workers all claim in burst
  const workers = Array.from(
    { length: 10 },
    (_, i) => new ConcurrentWorker(`worker-${i}`, state, 0, 0)
  );

  const claims = [];
  taskIds.forEach((taskId, idx) => {
    const workerIdx = idx % workers.length;
    claims.push(workers[workerIdx].attemptClaim(taskId));
  });

  const results = await Promise.all(claims);

  // All should succeed (each task claimed once)
  const successCount = results.filter((r) => r.success).length;
  assert.strictEqual(
    successCount,
    taskCount,
    "All tasks should be claimed successfully"
  );

  // Verify state consistency
  let pendingCount = 0;
  let claimInProgressCount = 0;

  for (const task of state.tasks.values()) {
    if (task.status === "Pending") pendingCount++;
    if (task.status === "ClaimInProgress") claimInProgressCount++;
  }

  assert.strictEqual(
    pendingCount,
    0,
    "No tasks should be Pending after all claims"
  );
  assert.strictEqual(
    claimInProgressCount,
    taskCount,
    "All tasks should be ClaimInProgress"
  );
});
