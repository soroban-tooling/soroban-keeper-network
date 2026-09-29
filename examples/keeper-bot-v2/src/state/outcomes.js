/**
 * Persistent outcome recording and on-chain verification under retried submissions (Issue #410).
 *
 * Prevents ambiguous timeouts (RPC timeout while tx landed on-chain) from
 * corrupting bot state or masking successful executions. Ensures idempotent
 * outcome recording under retries.
 */

"use strict";

const OutcomeAction = Object.freeze({
  CLAIM: "claim",
  EXECUTE: "execute",
  EXPIRE: "expire",
});

const OutcomeStatus = Object.freeze({
  SUCCESS: "SUCCESS",
  FAILED: "FAILED",
  PENDING: "PENDING",
});

/**
 * Determines whether an error represents an ambiguous timeout where the
 * transaction might have landed on-chain despite the local client failure.
 *
 * @param {Error} err
 * @returns {boolean}
 */
function isAmbiguousTimeoutError(err) {
  if (!err) return false;
  const code = (err.code || "").toUpperCase();
  const msg = (err.message || "").toLowerCase();

  return (
    code === "ETIMEDOUT" ||
    code === "ECONNRESET" ||
    code === "ESOCKETTIMEDOUT" ||
    code === "UND_ERR_HEADERS_TIMEOUT" ||
    code === "UND_ERR_BODY_TIMEOUT" ||
    msg.includes("timeout") ||
    msg.includes("timed out") ||
    msg.includes("deadline exceeded") ||
    msg.includes("gateway timeout") ||
    msg.includes("504") ||
    msg.includes("request aborted")
  );
}

/**
 * Normalizes task IDs to strings for deterministic indexing.
 */
function normalizeTaskId(taskId) {
  if (taskId === null || taskId === undefined) {
    throw new Error("taskId is required");
  }
  return taskId.toString();
}

/**
 * Verifies whether on-chain task state indicates the action actually landed.
 *
 * @param {string} action - 'claim' | 'execute' | 'expire'
 * @param {string} keeperAddress - Expected keeper public key
 * @param {Object} task - Task state retrieved from get_task / getTask
 * @returns {boolean}
 */
function verifyOnChainLanding(action, keeperAddress, task) {
  if (!task) return false;

  const status = typeof task.status === "number" ? task.status : task.status;
  const claimer = task.claimer ? task.claimer.toString() : null;
  const expectedKeeper = keeperAddress ? keeperAddress.toString() : null;

  switch (action) {
    case OutcomeAction.EXECUTE:
      // Status 2 is Executed
      return (
        (status === 2 || status === "Executed" || status === "executed") &&
        (!expectedKeeper || claimer === expectedKeeper)
      );

    case OutcomeAction.CLAIM:
      // Status 1 is Claimed
      return (
        (status === 1 || status === "Claimed" || status === "claimed") &&
        (!expectedKeeper || claimer === expectedKeeper)
      );

    case OutcomeAction.EXPIRE:
      // Status 4 is Expired
      return status === 4 || status === "Expired" || status === "expired";

    default:
      return false;
  }
}

/**
 * OutcomeStore manages recorded task lifecycle outcomes with idempotency guarantees.
 */
class OutcomeStore {
  constructor() {
    this._outcomes = new Map();
  }

  /**
   * Generates a unique key for a task and action.
   */
  _key(taskId, action) {
    return `${normalizeTaskId(taskId)}:${action}`;
  }

  /**
   * Records a task action outcome. Idempotent: repeated calls with identical
   * outcomes or retried attempts after a success are no-ops that preserve state.
   *
   * @param {string|number|bigint} taskId
   * @param {string} action
   * @param {Object} outcome
   * @returns {Object} Stored outcome record
   */
  recordOutcome(taskId, action, outcome) {
    const key = this._key(taskId, action);
    const existing = this._outcomes.get(key);

    // Idempotency: If already recorded as SUCCESS, do not overwrite with FAILED
    // from a delayed retry or crash recovery.
    if (existing && existing.status === OutcomeStatus.SUCCESS) {
      if (outcome && outcome.status === OutcomeStatus.FAILED) {
        return existing;
      }
      // If recording SUCCESS again, return existing without corruption
      return existing;
    }

    const record = {
      taskId: normalizeTaskId(taskId),
      action,
      status: outcome.status || OutcomeStatus.SUCCESS,
      timestamp: outcome.timestamp || Date.now(),
      verifiedOnChain: Boolean(outcome.verifiedOnChain),
      recoveredFromTimeout: Boolean(outcome.recoveredFromTimeout),
      reason: outcome.reason || outcome.error || null,
      metadata: outcome.metadata || {},
    };

    this._outcomes.set(key, record);
    return record;
  }

  /**
   * Retrieves the recorded outcome for a task action.
   *
   * @param {string|number|bigint} taskId
   * @param {string} action
   * @returns {Object|null}
   */
  getOutcome(taskId, action) {
    return this._outcomes.get(this._key(taskId, action)) || null;
  }

  /**
   * Checks whether a task action has a successful outcome recorded.
   */
  hasSuccess(taskId, action) {
    const record = this.getOutcome(taskId, action);
    return Boolean(record && record.status === OutcomeStatus.SUCCESS);
  }

  /**
   * Clears all stored outcomes (primarily for test resets).
   */
  clear() {
    this._outcomes.clear();
  }

  /**
   * Total number of stored outcomes.
   */
  get size() {
    return this._outcomes.size;
  }

  /**
   * Submits a transaction with ambiguous timeout recovery and idempotent recording.
   *
   * @param {string|number|bigint} taskId
   * @param {string} action
   * @param {string} keeperAddress
   * @param {Function} submissionFn - () => Promise<any>
   * @param {Object} options - { getTask: (id) => Promise<Task>, logger: Function }
   * @returns {Promise<Object>}
   */
  async recordSubmissionWithVerification(
    taskId,
    action,
    keeperAddress,
    submissionFn,
    options = {}
  ) {
    const log = options.logger || (() => {});

    try {
      const result = await submissionFn();
      const outcome = this.recordOutcome(taskId, action, {
        status: OutcomeStatus.SUCCESS,
        verifiedOnChain: false,
        metadata: { txResult: result },
      });
      return { success: true, outcome, result };
    } catch (err) {
      if (isAmbiguousTimeoutError(err) && typeof options.getTask === "function") {
        log(`  Ambiguous timeout detected for task ${taskId} (${action}) — verifying on-chain state...`);
        try {
          const onChainTask = await options.getTask(taskId);
          const landed = verifyOnChainLanding(action, keeperAddress, onChainTask);

          if (landed) {
            log(`  Task ${taskId} (${action}) confirmed successful on-chain despite RPC timeout.`);
            const outcome = this.recordOutcome(taskId, action, {
              status: OutcomeStatus.SUCCESS,
              verifiedOnChain: true,
              recoveredFromTimeout: true,
              metadata: { onChainTask },
            });
            return {
              success: true,
              outcome,
              recoveredFromTimeout: true,
              result: null,
            };
          }
        } catch (verifyErr) {
          log(`  On-chain state verification query failed: ${verifyErr.message}`);
        }
      }

      this.recordOutcome(taskId, action, {
        status: OutcomeStatus.FAILED,
        reason: err.message,
      });
      throw err;
    }
  }
}

module.exports = {
  OutcomeAction,
  OutcomeStatus,
  OutcomeStore,
  isAmbiguousTimeoutError,
  verifyOnChainLanding,
};
