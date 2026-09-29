"use strict";

const { TaskStateRegistry } = require("./state.js");
const { prioritizeCandidates } = require("./prioritization.js");
const { executeTaskOffChain } = require("./executors.js");
const { metrics: defaultMetrics } = require("./metrics.js");

const DEFAULT_MAX_ROUND_SPEND_STROOPS = 5_000_000n; // 0.5 XLM
const ESTIMATED_CLAIM_FEE_STROOPS = 10_000n;
const ESTIMATED_EXECUTE_BASE_FEE_STROOPS = 50_000n;

/**
 * Checks whether an error signifies that another keeper won the claim race.
 * In a competitive network, losing a claim race is expected normal behavior.
 */
function isLostClaimRaceError(err) {
  if (!err) return false;
  const msg = (err.message || String(err)).toLowerCase();
  return (
    msg.includes("already claimed") ||
    msg.includes("already locked") ||
    msg.includes("tasknotpending") ||
    msg.includes("task not pending") ||
    msg.includes("taskalreadyclaimed") ||
    msg.includes("lost claim race") ||
    msg.includes("contract error: #2") ||
    msg.includes("error(contract, #2)")
  );
}

/**
 * Checks whether an error is a permanent contract error that should abort retries.
 */
function isPermanentError(err) {
  if (!err) return false;
  const msg = (err.message || String(err)).toLowerCase();
  return (
    isLostClaimRaceError(err) ||
    msg.includes("simulation failed") ||
    msg.includes("invalidaction") ||
    msg.includes("unauthorized")
  );
}

/**
 * Executes a single keeper round with concurrency, profit prioritization,
 * competitive claim handling, and a strict per-round spend ceiling.
 */
async function runKeeperRound({
  client,
  candidateTasks = [],
  maxConcurrency = 4,
  maxTasksPerRound = 50,
  maxRoundSpendStroops = DEFAULT_MAX_ROUND_SPEND_STROOPS,
  minProfitMarginStroops = 0n,
  simulateExecution = false,
  stateRegistry = new TaskStateRegistry(),
  metrics = defaultMetrics,
  logger = console,
}) {
  metrics.startRound();
  metrics.recordEvaluated(candidateTasks.length);

  const summary = {
    processed: 0,
    claimed: 0,
    executed: 0,
    skipped: 0,
    errors: [],
    roundSpendStroops: 0n,
    ceilingReached: false,
  };

  const spendCeiling = BigInt(maxRoundSpendStroops);
  let roundSpend = 0n;
  let ceilingTripped = false;

  function canSpend(additionalStroops) {
    if (ceilingTripped) return false;
    if (roundSpend + BigInt(additionalStroops) > spendCeiling) {
      if (!ceilingTripped) {
        ceilingTripped = true;
        summary.ceilingReached = true;
        metrics.recordCeilingHit();
        logger.warn(
          `[RESOURCE CEILING] Hard round spend ceiling reached: spent ${roundSpend} stroops (ceiling: ${spendCeiling} stroops). Halting further transaction submissions for this round.`
        );
      }
      return false;
    }
    return true;
  }

  function chargeSpend(stroops) {
    const amount = BigInt(stroops);
    roundSpend += amount;
    summary.roundSpendStroops = roundSpend;
    metrics.recordSpend(amount);
  }

  // 1. Dynamic prioritization: rank candidate tasks by expected net profit
  const prioritized = prioritizeCandidates(candidateTasks, {
    minProfitMargin: minProfitMarginStroops,
    skipUnprofitable: false,
  });

  const queue = prioritized.slice(0, maxTasksPerRound);

  // 2. Worker processor for a single candidate task
  async function processCandidate({ task, profitInfo }) {
    if (ceilingTripped) {
      metrics.recordSkip("spend_ceiling_reached", task.taskId);
      stateRegistry.markSkipped(task.taskId, "spend_ceiling_reached");
      summary.skipped++;
      return;
    }

    // Profitability check backstop
    if (!profitInfo.profitable) {
      metrics.recordSkip("unprofitable", task.taskId);
      stateRegistry.markSkipped(task.taskId, "unprofitable");
      summary.skipped++;
      logger.log(`  Skipping task ${task.taskId}: ${profitInfo.reason}`);
      return;
    }

    // Acquire lock in local registry to prevent internal duplicate claims
    if (!stateRegistry.tryAcquire(task.taskId)) {
      metrics.recordSkip("already_in_flight", task.taskId);
      summary.skipped++;
      return;
    }

    // Check spend ceiling before submitting claim_task
    const estClaimFee = profitInfo.estimatedClaimFee || ESTIMATED_CLAIM_FEE_STROOPS;
    if (!canSpend(estClaimFee)) {
      metrics.recordSkip("spend_ceiling_reached", task.taskId);
      stateRegistry.markSkipped(task.taskId, "spend_ceiling_reached");
      summary.skipped++;
      return;
    }

    // Attempt claim
    try {
      logger.log(
        `  Claiming task ${task.taskId} (reward: ${task.reward}, est net profit: ${profitInfo.netProfit})...`
      );
      await client.claimTask(task.taskId);
      chargeSpend(estClaimFee);
      stateRegistry.markClaimed(task.taskId);
      summary.claimed++;
      metrics.recordClaimed(task.taskId);
    } catch (err) {
      if (isLostClaimRaceError(err)) {
        // Multi-keeper competition: lost claim race is success-with-skip
        logger.log(
          `[COMPETITION] Task ${task.taskId} already claimed by competitor keeper; treating as normal skip.`
        );
        stateRegistry.markSkipped(task.taskId, "lost_claim_race");
        metrics.recordSkip("lost_claim_race", task.taskId);
        summary.skipped++;
        // Do NOT add to summary.errors and do NOT log as error
        return;
      }

      // Genuine claim failure
      logger.error(`  Failed to claim task ${task.taskId}: ${err.message}`);
      stateRegistry.markFailed(task.taskId, err);
      summary.errors.push(err);
      metrics.recordError(err);
      return;
    }

    // Execute off-chain
    let proof = null;
    try {
      const execCtx = {
        taskId: task.taskId,
        log: (msg) => logger.log(msg),
      };
      proof = await executeTaskOffChain(task, execCtx, simulateExecution);
    } catch (err) {
      logger.error(`  Off-chain execution threw for task ${task.taskId}: ${err.message}`);
    }

    if (!proof) {
      logger.log(
        `  Skipping execute for task ${task.taskId}: no valid proof produced.`
      );
      stateRegistry.markSkipped(task.taskId, "unsupported_executor");
      metrics.recordSkip("unsupported_executor", task.taskId);
      summary.skipped++;
      return;
    }

    // Check spend ceiling before submitting execute_task
    const estExecFee = profitInfo.estimatedExecuteFee || ESTIMATED_EXECUTE_BASE_FEE_STROOPS;
    if (!canSpend(estExecFee)) {
      metrics.recordSkip("spend_ceiling_reached", task.taskId);
      stateRegistry.markSkipped(task.taskId, "spend_ceiling_reached");
      summary.skipped++;
      return;
    }

    // Submit execute_task on-chain
    try {
      logger.log(`  Executing task ${task.taskId} on-chain with proof...`);
      await client.executeTask(task.taskId, proof);
      chargeSpend(estExecFee);
      stateRegistry.markExecuted(task.taskId);
      summary.executed++;
      summary.processed++;
      metrics.recordExecuted(task.taskId);
    } catch (err) {
      logger.error(`  Failed to execute task ${task.taskId}: ${err.message}`);
      stateRegistry.markFailed(task.taskId, err);
      summary.errors.push(err);
      metrics.recordError(err);
    }
  }

  // 3. Worker pool concurrency execution
  const activePromises = new Set();
  for (const item of queue) {
    if (ceilingTripped) {
      metrics.recordSkip("spend_ceiling_reached", item.task.taskId);
      summary.skipped++;
      continue;
    }

    const p = (async () => {
      try {
        await processCandidate(item);
      } finally {
        activePromises.delete(p);
      }
    })();

    activePromises.add(p);
    if (activePromises.size >= maxConcurrency) {
      await Promise.race(activePromises);
    }
  }

  await Promise.all(activePromises);

  return summary;
}

module.exports = {
  DEFAULT_MAX_ROUND_SPEND_STROOPS,
  ESTIMATED_CLAIM_FEE_STROOPS,
  ESTIMATED_EXECUTE_BASE_FEE_STROOPS,
  isLostClaimRaceError,
  isPermanentError,
  runKeeperRound,
};
