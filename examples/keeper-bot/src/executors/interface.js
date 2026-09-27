/**
 * Executor plugin interface and timeout bounding for Keeper Bot (Issue #408).
 *
 * Provides configurable execution timeouts per task type, preventing
 * hung, slow, or malicious executors from holding claimed tasks past
 * their lock window.
 */

"use strict";

const DEFAULT_EXECUTOR_TIMEOUT_MS = 10_000;

const EXECUTOR_TIMEOUTS_MS = Object.freeze({
  Liquidation: 15_000,
  OraclePricePush: 5_000,
  FundingRateUpdate: 5_000,
  LiquidityRebalance: 10_000,
  TtlExtension: 5_000,
  Custom: 10_000,
});

/**
 * Resolves the execution timeout for a given task type.
 *
 * @param {string} taskTypeName - The name of the task type (e.g. 'Liquidation')
 * @param {Object} [customTimeouts] - Optional custom timeout map
 * @returns {number} Timeout in milliseconds
 */
function getExecutorTimeout(taskTypeName, customTimeouts = {}) {
  if (customTimeouts && typeof customTimeouts[taskTypeName] === "number" && customTimeouts[taskTypeName] > 0) {
    return customTimeouts[taskTypeName];
  }
  if (EXECUTOR_TIMEOUTS_MS[taskTypeName]) {
    return EXECUTOR_TIMEOUTS_MS[taskTypeName];
  }
  if (customTimeouts && typeof customTimeouts.default === "number" && customTimeouts.default > 0) {
    return customTimeouts.default;
  }
  return DEFAULT_EXECUTOR_TIMEOUT_MS;
}

/**
 * Runs an executor function under a configurable timeout, aborting if the
 * executor exceeds the duration.
 *
 * @param {Function} executorFn - Async executor function (task, ctx) => Promise<Buffer|null>
 * @param {Object} task - The task record
 * @param {Object} ctx - The execution context
 * @param {number} timeoutMs - Timeout in milliseconds
 * @returns {Promise<Buffer|null>}
 */
async function executeWithTimeout(executorFn, task, ctx, timeoutMs) {
  const controller = new AbortController();
  const executorCtx = {
    ...ctx,
    signal: controller.signal,
  };

  let timer = null;
  let settled = false;

  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      settled = true;
      try {
        controller.abort();
      } catch {
        // Ignore abort errors
      }
      const err = new Error(
        `Executor for task ${task.taskId} (${task.taskTypeName || "Unknown"}) exceeded timeout of ${timeoutMs}ms`
      );
      err.code = "EXECUTOR_TIMEOUT";
      err.taskId = task.taskId;
      err.taskTypeName = task.taskTypeName;
      reject(err);
    }, timeoutMs);

    if (timer && typeof timer.unref === "function") {
      timer.unref();
    }
  });

  try {
    const result = await Promise.race([
      Promise.resolve().then(() => executorFn(task, executorCtx)),
      timeoutPromise,
    ]);
    return result;
  } finally {
    if (!settled && timer) {
      clearTimeout(timer);
    }
  }
}

module.exports = {
  DEFAULT_EXECUTOR_TIMEOUT_MS,
  EXECUTOR_TIMEOUTS_MS,
  getExecutorTimeout,
  executeWithTimeout,
};
