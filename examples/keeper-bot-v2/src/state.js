"use strict";

/**
 * Task state registry to prevent internal worker double-claiming and track
 * lifecycle states for candidate tasks.
 */
const TaskStatus = {
  DISCOVERED: "DISCOVERED",
  IN_FLIGHT: "IN_FLIGHT",
  CLAIMED: "CLAIMED",
  EXECUTED: "EXECUTED",
  SKIPPED: "SKIPPED",
  FAILED: "FAILED",
};

class TaskStateRegistry {
  constructor() {
    this.tasks = new Map();
  }

  get(taskId) {
    return this.tasks.get(String(taskId));
  }

  /**
   * Attempts to lock a task ID for the calling worker.
   * Returns true if successfully reserved, false if already being processed or completed.
   */
  tryAcquire(taskId) {
    const idStr = String(taskId);
    const existing = this.tasks.get(idStr);
    if (
      existing &&
      (existing.status === TaskStatus.IN_FLIGHT ||
        existing.status === TaskStatus.CLAIMED ||
        existing.status === TaskStatus.EXECUTED)
    ) {
      return false;
    }

    this.tasks.set(idStr, {
      taskId: idStr,
      status: TaskStatus.IN_FLIGHT,
      updatedAt: Date.now(),
    });
    return true;
  }

  markClaimed(taskId) {
    const idStr = String(taskId);
    const entry = this.tasks.get(idStr) || { taskId: idStr };
    entry.status = TaskStatus.CLAIMED;
    entry.updatedAt = Date.now();
    this.tasks.set(idStr, entry);
  }

  markExecuted(taskId) {
    const idStr = String(taskId);
    const entry = this.tasks.get(idStr) || { taskId: idStr };
    entry.status = TaskStatus.EXECUTED;
    entry.updatedAt = Date.now();
    this.tasks.set(idStr, entry);
  }

  markSkipped(taskId, reason) {
    const idStr = String(taskId);
    const entry = this.tasks.get(idStr) || { taskId: idStr };
    entry.status = TaskStatus.SKIPPED;
    entry.skipReason = reason;
    entry.updatedAt = Date.now();
    this.tasks.set(idStr, entry);
  }

  markFailed(taskId, err) {
    const idStr = String(taskId);
    const entry = this.tasks.get(idStr) || { taskId: idStr };
    entry.status = TaskStatus.FAILED;
    entry.error = err && err.message ? err.message : String(err);
    entry.updatedAt = Date.now();
    this.tasks.set(idStr, entry);
  }

  release(taskId) {
    const idStr = String(taskId);
    this.tasks.delete(idStr);
  }

  clear() {
    this.tasks.clear();
  }
}

module.exports = {
  TaskStatus,
  TaskStateRegistry,
};
