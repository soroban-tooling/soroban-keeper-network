/**
 * Test suite for executor timeout bounding and per-task_type configuration (Issue #408).
 *
 * Verifies that:
 * 1. An executor exceeding its configured timeout is aborted and treated as a failed execution attempt (returns null).
 * 2. The round continues processing other candidates after an executor timeout.
 * 3. The timeout is configurable per task_type.
 * 4. Cooperative cancellation via ctx.signal functions properly.
 */

"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const {
  executeTaskOffChain,
  EXECUTORS,
  DEFAULT_EXECUTOR_TIMEOUT_MS,
  EXECUTOR_TIMEOUTS_MS,
  getExecutorTimeout,
  executeWithTimeout,
} = require("../index.js");

function makeCtx(overrides = {}) {
  const logs = [];
  return {
    server: {},
    keypair: {},
    networkPassphrase: "test",
    log: (msg) => logs.push(msg),
    logs,
    ...overrides,
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("Executor timeout configuration (Issue #408)", () => {
  it("provides sensible default timeouts per task_type", () => {
    assert.strictEqual(typeof DEFAULT_EXECUTOR_TIMEOUT_MS, "number");
    assert.ok(DEFAULT_EXECUTOR_TIMEOUT_MS > 0);
    assert.strictEqual(EXECUTOR_TIMEOUTS_MS.OraclePricePush, 5_000);
    assert.strictEqual(EXECUTOR_TIMEOUTS_MS.Liquidation, 15_000);
    assert.strictEqual(EXECUTOR_TIMEOUTS_MS.FundingRateUpdate, 5_000);
    assert.strictEqual(EXECUTOR_TIMEOUTS_MS.LiquidityRebalance, 10_000);
    assert.strictEqual(EXECUTOR_TIMEOUTS_MS.TtlExtension, 5_000);
    assert.strictEqual(EXECUTOR_TIMEOUTS_MS.Custom, 10_000);
  });

  it("resolves timeout based on task_type", () => {
    assert.strictEqual(getExecutorTimeout("OraclePricePush"), 5_000);
    assert.strictEqual(getExecutorTimeout("Liquidation"), 15_000);
    assert.strictEqual(getExecutorTimeout("NonExistentType"), DEFAULT_EXECUTOR_TIMEOUT_MS);
  });

  it("allows custom overrides per task_type", () => {
    const custom = {
      OraclePricePush: 2_500,
      default: 8_000,
    };
    assert.strictEqual(getExecutorTimeout("OraclePricePush", custom), 2_500);
    assert.strictEqual(getExecutorTimeout("Liquidation", custom), 15_000);
    assert.strictEqual(getExecutorTimeout("Unknown", custom), 8_000);
  });
});

describe("executeWithTimeout (Issue #408)", () => {
  it("completes normally when executor finishes well within timeout", async () => {
    const task = { taskId: 101n, taskTypeName: "OraclePricePush" };
    const ctx = makeCtx();
    const result = await executeWithTimeout(
      async () => Buffer.from("fast-proof"),
      task,
      ctx,
      1_000
    );
    assert.strictEqual(result.toString(), "fast-proof");
  });

  it("aborts and rejects when executor exceeds timeout duration", async () => {
    const task = { taskId: 102n, taskTypeName: "OraclePricePush" };
    const ctx = makeCtx();
    let abortedSignalObserved = false;

    await assert.rejects(
      async () => {
        await executeWithTimeout(
          async (_t, innerCtx) => {
            innerCtx.signal.addEventListener("abort", () => {
              abortedSignalObserved = true;
            });
            await sleep(150);
            return Buffer.from("late-proof");
          },
          task,
          ctx,
          30
        );
      },
      (err) => {
        assert.strictEqual(err.code, "EXECUTOR_TIMEOUT");
        assert.ok(err.message.includes("exceeded timeout of 30ms"));
        return true;
      }
    );

    assert.strictEqual(abortedSignalObserved, true, "AbortController signal must be triggered on timeout");
  });
});

describe("executeTaskOffChain timeout integration (Issue #408)", () => {
  it("aborts a hung executor and returns null without throwing", async () => {
    const original = EXECUTORS.Custom;
    EXECUTORS.Custom = async (_task, innerCtx) => {
      // Simulate hung executor listening to signal
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 500);
        innerCtx.signal.addEventListener("abort", () => {
          clearTimeout(timer);
          resolve();
        });
      });
      return Buffer.from("hung-proof");
    };

    try {
      const task = {
        taskId: 201n,
        taskType: 5,
        taskTypeName: "Custom",
        deadline: Math.floor(Date.now() / 1000) + 3600,
      };
      const ctx = makeCtx({ executorTimeoutMs: 40 });

      const proof = await executeTaskOffChain(task, ctx, false);

      assert.strictEqual(proof, null, "Timed-out executor must produce null proof");
      assert.ok(
        ctx.logs.some((l) => l.includes("timed out after 40ms")),
        "Must log the timeout occurrence"
      );
    } finally {
      EXECUTORS.Custom = original;
    }
  });

  it("continues processing other candidates after an executor timeout", async () => {
    const originalCustom = EXECUTORS.Custom;
    const originalTtl = EXECUTORS.TtlExtension;

    // Hung executor for task 1 (Custom)
    EXECUTORS.Custom = async () => {
      await sleep(200);
      return Buffer.from("custom-proof");
    };

    // Fast working executor for task 2 (TtlExtension)
    EXECUTORS.TtlExtension = async (t) => {
      return Buffer.from(`ttl-proof:${t.taskId}`);
    };

    try {
      const task1 = { taskId: 301n, taskType: 5, taskTypeName: "Custom" };
      const task2 = { taskId: 302n, taskType: 4, taskTypeName: "TtlExtension" };

      const ctx = makeCtx({
        executorTimeouts: {
          Custom: 30, // Custom times out quickly
          TtlExtension: 500, // TtlExtension has plenty of time
        },
      });

      // Task 1 times out
      const proof1 = await executeTaskOffChain(task1, ctx, false);
      assert.strictEqual(proof1, null);

      // Task 2 completes successfully despite Task 1 timing out in the same round
      const proof2 = await executeTaskOffChain(task2, ctx, false);
      assert.ok(Buffer.isBuffer(proof2));
      assert.strictEqual(proof2.toString(), "ttl-proof:302");
    } finally {
      EXECUTORS.Custom = originalCustom;
      EXECUTORS.TtlExtension = originalTtl;
    }
  });

  it("honors per-task_type timeout configuration", async () => {
    const originalOracle = EXECUTORS.OraclePricePush;
    const originalLiquidation = EXECUTORS.Liquidation;

    // Executor running for 60ms
    EXECUTORS.OraclePricePush = async () => {
      await sleep(60);
      return Buffer.from("oracle-proof");
    };
    EXECUTORS.Liquidation = async () => {
      await sleep(60);
      return Buffer.from("liquidation-proof");
    };

    try {
      const oracleTask = { taskId: 401n, taskType: 1, taskTypeName: "OraclePricePush" };
      const liqTask = { taskId: 402n, taskType: 0, taskTypeName: "Liquidation" };

      // Configure OraclePricePush with 25ms (will fail) and Liquidation with 150ms (will pass)
      const ctx = makeCtx({
        executorTimeouts: {
          OraclePricePush: 25,
          Liquidation: 150,
        },
      });

      const oracleProof = await executeTaskOffChain(oracleTask, ctx, false);
      const liqProof = await executeTaskOffChain(liqTask, ctx, false);

      assert.strictEqual(oracleProof, null, "OraclePricePush should time out at 25ms");
      assert.ok(Buffer.isBuffer(liqProof), "Liquidation should succeed with 150ms timeout");
      assert.strictEqual(liqProof.toString(), "liquidation-proof");
    } finally {
      EXECUTORS.OraclePricePush = originalOracle;
      EXECUTORS.Liquidation = originalLiquidation;
    }
  });
});
