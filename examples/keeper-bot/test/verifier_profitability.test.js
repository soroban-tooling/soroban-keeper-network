/**
 * Test suite for verifier support and profitability checking (issue #116 / 0090 / 0041).
 *
 * Guarantees under test:
 * 1. Tasks with unrecognized verifier contracts are skipped pre-claim when no strategy exists.
 * 2. Tasks with recognized verifiers or standard executor support proceed.
 * 3. Tasks that fail the profitability threshold (reward < estimated gas + profit margin) are skipped pre-claim.
 * 4. Verifier resource cost increases are factored into the estimated transaction fee.
 */

"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const {
  checkVerifierSupport,
  estimateTaskProfitability,
  VERIFIER_STRATEGIES,
  executeTaskOffChain,
  ESTIMATED_CLAIM_FEE_STROOPS,
  ESTIMATED_EXECUTE_BASE_FEE_STROOPS,
} = require("../index.js");

function makeCtx() {
  const logs = [];
  return {
    server: {},
    keypair: {},
    networkPassphrase: "test",
    log: (msg) => logs.push(msg),
    logs,
  };
}

describe("checkVerifierSupport", () => {
  const UNKNOWN_VERIFIER = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
  const KNOWN_VERIFIER = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";

  it("supports task without verifier if executor is registered", () => {
    const task = {
      taskId: 1n,
      taskType: 4,
      taskTypeName: "TtlExtension",
      verifier: null,
    };
    const res = checkVerifierSupport(task, false);
    assert.strictEqual(res.supported, true);
  });

  it("rejects task without verifier if no executor is registered and simulateExecution=false", () => {
    const task = {
      taskId: 2n,
      taskType: 0,
      taskTypeName: "Liquidation",
      verifier: null,
    };
    const res = checkVerifierSupport(task, false);
    assert.strictEqual(res.supported, false);
    assert.ok(res.reason.includes("no executor registered"));
  });

  it("accepts task without executor if simulateExecution=true", () => {
    const task = {
      taskId: 3n,
      taskType: 0,
      taskTypeName: "Liquidation",
      verifier: null,
    };
    const res = checkVerifierSupport(task, true);
    assert.strictEqual(res.supported, true);
  });

  it("rejects task with unrecognized verifier contract", () => {
    const task = {
      taskId: 4n,
      taskType: 4,
      taskTypeName: "TtlExtension",
      verifier: UNKNOWN_VERIFIER,
    };
    const res = checkVerifierSupport(task, false);
    assert.strictEqual(res.supported, false);
    assert.ok(res.reason.includes("unrecognized verifier contract"));
  });

  it("accepts task with registered verifier strategy", () => {
    VERIFIER_STRATEGIES[KNOWN_VERIFIER] = async (_t, _c) => Buffer.from("proof");
    try {
      const task = {
        taskId: 5n,
        taskType: 5,
        taskTypeName: "Custom",
        verifier: KNOWN_VERIFIER,
      };
      const res = checkVerifierSupport(task, false);
      assert.strictEqual(res.supported, true);
    } finally {
      delete VERIFIER_STRATEGIES[KNOWN_VERIFIER];
    }
  });

  it("accepts unrecognized verifier in simulateExecution mode", () => {
    const task = {
      taskId: 6n,
      taskType: 5,
      taskTypeName: "Custom",
      verifier: UNKNOWN_VERIFIER,
    };
    const res = checkVerifierSupport(task, true);
    assert.strictEqual(res.supported, true);
  });
});

describe("executeTaskOffChain with verifier strategies", () => {
  const VERIFIER_ADDR = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";

  it("dispatches to registered verifier strategy when present", async () => {
    const ctx = makeCtx();
    VERIFIER_STRATEGIES[VERIFIER_ADDR] = async (task, _c) =>
      Buffer.from(`verifier-proof:${task.taskId}`);

    try {
      const task = {
        taskId: 10n,
        taskType: 5,
        taskTypeName: "Custom",
        verifier: VERIFIER_ADDR,
      };
      const proof = await executeTaskOffChain(task, ctx, false);
      assert.ok(Buffer.isBuffer(proof));
      assert.strictEqual(proof.toString(), "verifier-proof:10");
    } finally {
      delete VERIFIER_STRATEGIES[VERIFIER_ADDR];
    }
  });

  it("returns null when verifier strategy throws", async () => {
    const ctx = makeCtx();
    VERIFIER_STRATEGIES[VERIFIER_ADDR] = async () => {
      throw new Error("verifier proof generation error");
    };

    try {
      const task = {
        taskId: 11n,
        taskType: 5,
        taskTypeName: "Custom",
        verifier: VERIFIER_ADDR,
      };
      const proof = await executeTaskOffChain(task, ctx, false);
      assert.strictEqual(proof, null);
      assert.ok(ctx.logs.some((l) => l.includes("Verifier strategy for task 11 threw")));
    } finally {
      delete VERIFIER_STRATEGIES[VERIFIER_ADDR];
    }
  });
});

describe("estimateTaskProfitability", () => {
  it("marks task profitable when reward exceeds gas fees + minProfitMargin", async () => {
    const task = {
      taskId: 20n,
      reward: 1_000_000n, // 0.1 XLM
      verifier: null,
    };

    const res = await estimateTaskProfitability({
      task,
      minProfitMargin: 100_000n,
    });

    assert.strictEqual(res.profitable, true);
    assert.strictEqual(res.estimatedFee, ESTIMATED_CLAIM_FEE_STROOPS + ESTIMATED_EXECUTE_BASE_FEE_STROOPS);
    assert.strictEqual(res.netProfit, 1_000_000n - res.estimatedFee);
  });

  it("marks task unprofitable when reward is less than estimated fees", async () => {
    const task = {
      taskId: 21n,
      reward: 20_000n, // less than claim fee (10k) + execute fee (50k) = 60k
      verifier: null,
    };

    const res = await estimateTaskProfitability({
      task,
      minProfitMargin: 0n,
    });

    assert.strictEqual(res.profitable, false);
    assert.ok(res.reason.includes("below minimum margin"));
  });

  it("marks task unprofitable when reward meets fees but not minProfitMargin", async () => {
    const task = {
      taskId: 22n,
      reward: 100_000n,
      verifier: null,
    };
    // estimated fees = 60,000 stroops. Net profit = 40,000 stroops.
    const res = await estimateTaskProfitability({
      task,
      minProfitMargin: 50_000n,
    });

    assert.strictEqual(res.profitable, false);
    assert.strictEqual(res.netProfit, 40_000n);
    assert.ok(res.reason.includes("below minimum margin"));
  });

  it("factors in additional verifier gas fee when verifier is attached", async () => {
    const taskNoVerifier = { taskId: 23n, reward: 200_000n, verifier: null };
    const taskWithVerifier = {
      taskId: 23n,
      reward: 200_000n,
      verifier: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM",
    };

    const res1 = await estimateTaskProfitability({ task: taskNoVerifier });
    const res2 = await estimateTaskProfitability({ task: taskWithVerifier });

    assert.ok(res2.estimatedFee > res1.estimatedFee);
    assert.ok(res2.netProfit < res1.netProfit);
  });

  it("uses simulation minResourceFee when RPC simulation succeeds", async () => {
    const { Account, Keypair } = require("@stellar/stellar-sdk");
    const sourcePublicKey = Keypair.random().publicKey();
    const fakeServer = {
      getAccount: async () => new Account(sourcePublicKey, "100"),
      simulateTransaction: async () => ({
        minResourceFee: "250000",
      }),
    };

    const task = {
      taskId: 24n,
      reward: 500_000n,
      verifier: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM",
    };

    const res = await estimateTaskProfitability({
      server: fakeServer,
      sourcePublicKey,
      networkPassphrase: "test",
      task,
      minProfitMargin: 0n,
    });

    // Total fees: 10k (claim) + 50k (exec) + 250k (sim verifier) = 310k
    assert.strictEqual(res.estimatedFee, 310_000n);
    assert.strictEqual(res.profitable, true);
    assert.strictEqual(res.netProfit, 500_000n - 310_000n);
  });

  it("rejects task when verifier RPC simulation fails", async () => {
    const { Account, Keypair } = require("@stellar/stellar-sdk");
    const sourcePublicKey = Keypair.random().publicKey();
    const fakeServer = {
      getAccount: async () => new Account(sourcePublicKey, "100"),
      simulateTransaction: async () => ({
        error: "HostError: Error(Contract, #1)",
      }),
    };

    const res = await estimateTaskProfitability({
      server: fakeServer,
      sourcePublicKey,
      networkPassphrase: "test",
      task: {
        taskId: 25n,
        reward: 500_000n,
        verifier: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM",
      },
    });

    assert.strictEqual(res.profitable, false);
    assert.ok(res.reason.includes("verifier simulation failed"));
  });
});
