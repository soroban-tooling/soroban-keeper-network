/**
 * Testnet end-to-end liveness canary (issue #727).
 *
 * Registers a tiny task on a fixed schedule, waits for a keeper to execute it,
 * and records the observed time to execution. The task type, owner, target and
 * schedule are all configuration; the RPC client and clock are injectable so
 * tests need neither testnet access nor wall-clock waiting.
 */

import { TaskStatus, TaskType } from "@soroban-keeper-network/sdk";
import { renderPrometheus } from "./metrics.mjs";

const DEFAULT_TARGET_MS = 60_000;
const DEFAULT_INTERVAL_MS = 10 * 60_000;
const DEFAULT_POLL_MS = 1_000;

export function createCanary({
  client,
  owner,
  taskIdLabel = "testnet-canary",
  targetMs = DEFAULT_TARGET_MS,
  intervalMs = DEFAULT_INTERVAL_MS,
  pollMs = DEFAULT_POLL_MS,
  reward = 1n,
  clock = { now: () => Date.now(), sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) },
  scheduler = globalThis,
  onSamples = () => {},
  onError = () => {},
}) {
  let registered = 0;
  let executions = 0;
  let missed = 0;
  let lastExecutionTimestamp = 0;
  let lastTimeToExecution = 0;
  let timer = undefined;
  let stopped = false;
  let runningRound = undefined;

  const labels = { task_id: taskIdLabel };

  function samples() {
    return [
      { name: "soroban_canary_last_execution_timestamp_seconds", labels, value: Math.floor(lastExecutionTimestamp / 1000) },
      { name: "soroban_canary_time_to_execution_seconds", labels, value: (lastTimeToExecution / 1000).toFixed(3) },
      { name: "soroban_canary_executions_total", labels, value: executions },
      { name: "soroban_canary_missed_executions_total", labels, value: missed },
    ];
  }

  async function register() {
    const now = clock.now();
    const id = await client.registerTask({
      owner,
      taskType: TaskType.Custom,
      calldata: new TextEncoder().encode(`canary:${registered + 1}`),
      reward,
      deadline: Math.floor((now + targetMs * 2) / 1000),
      ttlLedgers: 1000,
      lockLedgers: 10,
    });
    registered += 1;
    return id;
  }

  async function waitForExecution(taskId) {
    const started = clock.now();
    while (clock.now() - started <= targetMs) {
      const task = await client.getTask(taskId);
      if (task?.status === TaskStatus.Executed) return clock.now() - started;
      if (task?.status === TaskStatus.Cancelled || task?.status === TaskStatus.Expired) break;
      await clock.sleep(pollMs);
    }
    return undefined;
  }

  async function round() {
    try {
      const taskId = await register();
      const elapsed = await waitForExecution(taskId);
      if (elapsed === undefined) {
        missed += 1;
      } else {
        executions += 1;
        lastTimeToExecution = elapsed;
        lastExecutionTimestamp = clock.now();
      }
      const current = samples();
      onSamples(current);
      return current;
    } catch (error) {
      missed += 1;
      onError(error);
      return undefined;
    }
  }

  return {
    round,
    getSamples: samples,
    render: () => renderPrometheus(samples()),
    getStats: () => ({ registered, executions, missed }),
    start() {
      stopped = false;
      timer = scheduler.setInterval(() => {
        if (runningRound) return;
        runningRound = round().finally(() => {
          runningRound = undefined;
        });
      }, intervalMs);
      return round();
    },
    stop() {
      stopped = true;
      if (timer !== undefined) scheduler.clearInterval(timer);
      timer = undefined;
    },
    isRunning: () => !stopped && timer !== undefined,
  };
}
