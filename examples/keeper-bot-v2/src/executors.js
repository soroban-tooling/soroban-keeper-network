"use strict";

const TASK_TYPE_NAMES = {
  0: "Liquidation",
  1: "OraclePricePush",
  2: "FundingRateUpdate",
  3: "LiquidityRebalance",
  4: "TtlExtension",
  5: "Custom",
};

async function ttlExtensionExecutor(task, _ctx) {
  const now = Math.floor(Date.now() / 1000);
  if (task.deadline && task.deadline < now) {
    return null;
  }
  return Buffer.from(`ttl-extension:task:${task.taskId}`);
}

async function simulatedExecutor(task, _ctx) {
  return Buffer.from(`keeper-proof:task:${task.taskId}`);
}

const EXECUTORS = {
  TtlExtension: ttlExtensionExecutor,
};

async function executeTaskOffChain(task, ctx, simulateExecution = false) {
  const taskTypeName =
    task.taskTypeName || TASK_TYPE_NAMES[task.taskType] || `Unknown(${task.taskType})`;
  const executor = EXECUTORS[taskTypeName];

  if (!executor) {
    if (simulateExecution) {
      return simulatedExecutor(task, ctx);
    }
    return null;
  }

  try {
    return await executor(task, ctx);
  } catch (err) {
    if (ctx && typeof ctx.log === "function") {
      ctx.log(`Executor error for task ${task.taskId}: ${err.message}`);
    }
    return null;
  }
}

module.exports = {
  TASK_TYPE_NAMES,
  EXECUTORS,
  ttlExtensionExecutor,
  simulatedExecutor,
  executeTaskOffChain,
};
