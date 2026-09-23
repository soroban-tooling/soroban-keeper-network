"use strict";

/**
 * Lock-Window Aware Task Scheduling for Keeper Bot v2 (Issue #399).
 *
 * Contract lock expiry reference (`contracts/keeper-registry/src/internal.rs`):
 *   `let unlock_at = claimed_at.saturating_add(task.lock_ledgers);`
 *   `e.ledger().sequence() >= unlock_at`
 *
 * When the bot encounters a task currently locked by another keeper:
 * 1. Computes the exact unlock ledger (`claim_ledger + lock_ledgers`).
 * 2. Tracks the task in an internal priority schedule.
 * 3. Surfaces the task for targeted re-check once `current_ledger >= unlock_ledger`.
 * 4. Merges due re-check tasks additively into candidate task sets without
 *    disrupting normal polling discovery of newly registered tasks.
 */

/**
 * Computes the unlock ledger sequence number from a task's claim_ledger and lock_ledgers.
 * Matches `internal.rs`: `claim_ledger.saturating_add(task.lock_ledgers)`.
 *
 * @param {Object} task
 * @param {number|bigint|string} [task.claim_ledger] - Ledger when task was claimed.
 * @param {number|bigint|string} [task.claimLedger]
 * @param {number|bigint|string} [task.lock_ledgers] - Duration of lock window in ledgers.
 * @param {number|bigint|string} [task.lockLedgers]
 * @returns {number} The sequence number of the ledger when lock expires.
 */
function computeUnlockLedger(task) {
  if (!task || typeof task !== "object") {
    throw new Error("Invalid task: task object is required");
  }

  const rawClaim = task.claim_ledger ?? task.claimLedger;
  const rawLock = task.lock_ledgers ?? task.lockLedgers;

  const claimLedger = Number(rawClaim);
  const lockLedgers = Number(rawLock);

  if (Number.isNaN(claimLedger) || claimLedger <= 0) {
    throw new Error(`Invalid claim_ledger: expected positive integer, got ${rawClaim}`);
  }
  if (Number.isNaN(lockLedgers) || lockLedgers <= 0) {
    throw new Error(`Invalid lock_ledgers: expected positive integer, got ${rawLock}`);
  }

  return claimLedger + lockLedgers;
}

/**
 * Manages tracking of locked tasks and scheduling re-checks around unlock windows.
 */
class LockWindowScheduler {
  /**
   * @param {Object} [options]
   * @param {Object} [options.logger=console]
   */
  constructor(options = {}) {
    this.trackedTasks = new Map(); // taskId -> { task, unlockLedger, addedAt }
    this.logger = options.logger ?? console;
  }

  /**
   * Tracks a task locked by another keeper.
   * Computes the exact unlock ledger and adds the task to schedule.
   *
   * @param {Object} task
   * @returns {number} The computed unlock ledger.
   */
  trackLockedTask(task) {
    const taskId = String(task.taskId ?? task.task_id);
    const unlockLedger = computeUnlockLedger(task);

    this.trackedTasks.set(taskId, {
      taskId,
      task,
      unlockLedger,
      addedAt: Date.now(),
    });

    return unlockLedger;
  }

  /**
   * Check if a task is currently tracked.
   * @param {string|number|bigint} taskId
   * @returns {boolean}
   */
  isTracking(taskId) {
    return this.trackedTasks.has(String(taskId));
  }

  /**
   * Retrieves tracked metadata for a task.
   * @param {string|number|bigint} taskId
   * @returns {{ taskId: string, task: Object, unlockLedger: number, addedAt: number }|undefined}
   */
  getTrackedTask(taskId) {
    return this.trackedTasks.get(String(taskId));
  }

  /**
   * Removes a task from tracking (e.g. after execution, claim, or cancellation).
   * @param {string|number|bigint} taskId
   * @returns {boolean}
   */
  untrackTask(taskId) {
    return this.trackedTasks.delete(String(taskId));
  }

  /**
   * Returns list of tasks whose lock window has elapsed (`currentLedger >= unlockLedger`).
   * Does not remove them from tracking (use popDueTasks for consume-once semantics).
   *
   * @param {number} currentLedger
   * @returns {Object[]}
   */
  getDueTasks(currentLedger) {
    const ledger = Number(currentLedger);
    const due = [];

    for (const entry of this.trackedTasks.values()) {
      if (ledger >= entry.unlockLedger) {
        due.push(entry.task);
      }
    }

    return due;
  }

  /**
   * Returns and removes all tasks whose lock window has elapsed.
   *
   * @param {number} currentLedger
   * @returns {Object[]}
   */
  popDueTasks(currentLedger) {
    const due = this.getDueTasks(currentLedger);
    for (const task of due) {
      const taskId = String(task.taskId ?? task.task_id);
      this.trackedTasks.delete(taskId);
    }
    return due;
  }

  /**
   * Additively merges due re-check tasks with tasks freshly polled from network.
   * Ensures:
   * 1. Unlocked tasks get immediate priority re-evaluation.
   * 2. Regular polling discovers newly created tasks without interference.
   * 3. No duplicate task IDs exist in the final candidate array.
   *
   * @param {Object[]} [polledTasks=[]] - Newly polled tasks from standard discovery loop.
   * @param {number} [currentLedger=0] - Current ledger sequence.
   * @returns {Object[]} Combined candidate tasks.
   */
  mergeCandidateTasks(polledTasks = [], currentLedger = 0) {
    const dueTasks = this.popDueTasks(currentLedger);
    const candidates = [];
    const seenIds = new Set();

    // Priority 1: Due tasks whose locks just lapsed
    for (const task of dueTasks) {
      const id = String(task.taskId ?? task.task_id);
      if (!seenIds.has(id)) {
        seenIds.add(id);
        candidates.push(task);
      }
    }

    // Priority 2: Standard polled tasks
    for (const task of polledTasks) {
      const id = String(task.taskId ?? task.task_id);
      if (!seenIds.has(id)) {
        seenIds.add(id);
        candidates.push(task);
      }
    }

    return candidates;
  }

  /**
   * Number of tasks currently tracked.
   * @returns {number}
   */
  getTrackedCount() {
    return this.trackedTasks.size;
  }

  /**
   * Clears all tracked tasks.
   */
  clear() {
    this.trackedTasks.clear();
  }
}

module.exports = {
  computeUnlockLedger,
  LockWindowScheduler,
};
