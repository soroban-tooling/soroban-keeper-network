/**
 * Test suite for outcome recording idempotency and ambiguous timeout recovery (Issue #410).
 *
 * Verifies that:
 * 1. A timed-out submission whose transaction actually landed is correctly recorded as successful after an on-chain check, not marked failed.
 * 2. Recording the same outcome twice (a retried recording after a crash between submission and persistence) does not corrupt the stored state.
 * 3. A test simulates exactly this ambiguous-timeout scenario and confirms the final recorded state matches on-chain truth.
 */

"use strict";

const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert");
const {
  OutcomeStore,
  OutcomeAction,
  OutcomeStatus,
  isAmbiguousTimeoutError,
  verifyOnChainLanding,
} = require("../index.js");

describe("isAmbiguousTimeoutError classification", () => {
  it("detects standard Node / network timeout errors", () => {
    assert.strictEqual(isAmbiguousTimeoutError(new Error("Connection timed out")), true);
    assert.strictEqual(isAmbiguousTimeoutError(new Error("RPC request timeout after 15000ms")), true);
    assert.strictEqual(isAmbiguousTimeoutError(new Error("Gateway Timeout (504)")), true);
    assert.strictEqual(isAmbiguousTimeoutError({ code: "ETIMEDOUT", message: "connect ETIMEDOUT" }), true);
    assert.strictEqual(isAmbiguousTimeoutError({ code: "ECONNRESET", message: "read ECONNRESET" }), true);
    assert.strictEqual(isAmbiguousTimeoutError(new Error("Request aborted by client")), true);
  });

  it("does not classify non-timeout logic or contract errors as ambiguous", () => {
    assert.strictEqual(isAmbiguousTimeoutError(new Error("Task already claimed")), false);
    assert.strictEqual(isAmbiguousTimeoutError(new Error("HostError: VerificationFailed")), false);
    assert.strictEqual(isAmbiguousTimeoutError(new Error("Insufficient balance")), false);
    assert.strictEqual(isAmbiguousTimeoutError(null), false);
  });
});

describe("verifyOnChainLanding helper", () => {
  const KEEPER = "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H";
  const OTHER_KEEPER = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7";

  it("verifies executed tasks when status is Executed and claimer matches", () => {
    const executedTask = {
      id: 10n,
      status: 2, // TaskStatus::Executed
      claimer: KEEPER,
    };
    assert.strictEqual(verifyOnChainLanding(OutcomeAction.EXECUTE, KEEPER, executedTask), true);
    assert.strictEqual(verifyOnChainLanding(OutcomeAction.EXECUTE, OTHER_KEEPER, executedTask), false);
  });

  it("verifies claimed tasks when status is Claimed and claimer matches", () => {
    const claimedTask = {
      id: 11n,
      status: 1, // TaskStatus::Claimed
      claimer: KEEPER,
    };
    assert.strictEqual(verifyOnChainLanding(OutcomeAction.CLAIM, KEEPER, claimedTask), true);
    assert.strictEqual(verifyOnChainLanding(OutcomeAction.CLAIM, OTHER_KEEPER, claimedTask), false);
  });

  it("rejects execution verification if task is still Pending or Claimed", () => {
    const pendingTask = { id: 12n, status: 0, claimer: null };
    assert.strictEqual(verifyOnChainLanding(OutcomeAction.EXECUTE, KEEPER, pendingTask), false);

    const claimedTask = { id: 12n, status: 1, claimer: KEEPER };
    assert.strictEqual(verifyOnChainLanding(OutcomeAction.EXECUTE, KEEPER, claimedTask), false);
  });
});

describe("OutcomeStore idempotency & timeout recovery (Issue #410)", () => {
  let store;
  const KEEPER = "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H";

  beforeEach(() => {
    store = new OutcomeStore();
  });

  it("records successful outcomes cleanly", () => {
    const outcome = store.recordOutcome(42, OutcomeAction.EXECUTE, {
      status: OutcomeStatus.SUCCESS,
      timestamp: 1000,
    });

    assert.strictEqual(outcome.status, OutcomeStatus.SUCCESS);
    assert.strictEqual(outcome.taskId, "42");
    assert.strictEqual(store.hasSuccess(42, OutcomeAction.EXECUTE), true);
    assert.strictEqual(store.size, 1);
  });

  it("AC 2: duplicate recording for the same task and action does not corrupt stored state (idempotency)", () => {
    // Initial recording
    const first = store.recordOutcome(50, OutcomeAction.EXECUTE, {
      status: OutcomeStatus.SUCCESS,
      timestamp: 1000,
      metadata: { txHash: "0xabc" },
    });

    // Simulated retry after process crash or loop re-entry
    const second = store.recordOutcome(50, OutcomeAction.EXECUTE, {
      status: OutcomeStatus.SUCCESS,
      timestamp: 1005,
      metadata: { txHash: "0xabc" },
    });

    assert.strictEqual(store.size, 1, "Must maintain exactly one outcome record");
    assert.strictEqual(first, second, "Should return identical reference without duplicating");
    assert.strictEqual(second.status, OutcomeStatus.SUCCESS);
    assert.strictEqual(second.metadata.txHash, "0xabc");
  });

  it("prevents late failure retry from corrupting an existing SUCCESS state", () => {
    store.recordOutcome(51, OutcomeAction.EXECUTE, {
      status: OutcomeStatus.SUCCESS,
      timestamp: 1000,
    });

    // Stale error arriving from a background timeout retry
    const attemptedOverwrite = store.recordOutcome(51, OutcomeAction.EXECUTE, {
      status: OutcomeStatus.FAILED,
      reason: "RPC timed out after retry",
      timestamp: 1010,
    });

    assert.strictEqual(attemptedOverwrite.status, OutcomeStatus.SUCCESS, "State must remain SUCCESS");
    assert.strictEqual(store.hasSuccess(51, OutcomeAction.EXECUTE), true);
  });

  it("AC 1 & 3: timed-out submission whose tx landed on-chain is recorded as SUCCESS after check", async () => {
    const logs = [];
    const logger = (msg) => logs.push(msg);

    // Mock on-chain state where task was actually executed by our keeper on-chain
    const mockOnChainTask = {
      taskId: 100n,
      status: 2, // Executed
      claimer: KEEPER,
      reward: 10_000_000n,
    };

    const getTaskMock = async (taskId) => {
      assert.strictEqual(taskId.toString(), "100");
      return mockOnChainTask;
    };

    // Simulated submission call that throws an ambiguous timeout error (e.g. HTTP 504 from load balancer)
    const timedOutSubmission = async () => {
      const err = new Error("Gateway Timeout (504): Soroban RPC did not respond in 30000ms");
      err.code = "ETIMEDOUT";
      throw err;
    };

    const result = await store.recordSubmissionWithVerification(
      100n,
      OutcomeAction.EXECUTE,
      KEEPER,
      timedOutSubmission,
      { getTask: getTaskMock, logger }
    );

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.recoveredFromTimeout, true);

    const storedOutcome = store.getOutcome(100n, OutcomeAction.EXECUTE);
    assert.ok(storedOutcome, "Outcome must be recorded");
    assert.strictEqual(storedOutcome.status, OutcomeStatus.SUCCESS, "Must be recorded as SUCCESS, not FAILED");
    assert.strictEqual(storedOutcome.verifiedOnChain, true);
    assert.strictEqual(storedOutcome.recoveredFromTimeout, true);
    assert.ok(logs.some((l) => l.includes("confirmed successful on-chain despite RPC timeout")));
  });

  it("records FAILED if timed-out submission did NOT land on-chain", async () => {
    // Mock on-chain state where task is still Pending (tx did not land)
    const mockPendingTask = {
      taskId: 101n,
      status: 0, // Pending
      claimer: null,
    };

    const getTaskMock = async () => mockPendingTask;

    const timedOutSubmission = async () => {
      const err = new Error("RPC timeout: request timed out");
      err.code = "ETIMEDOUT";
      throw err;
    };

    await assert.rejects(
      async () => {
        await store.recordSubmissionWithVerification(
          101n,
          OutcomeAction.EXECUTE,
          KEEPER,
          timedOutSubmission,
          { getTask: getTaskMock }
        );
      },
      (err) => {
        assert.ok(err.message.includes("RPC timeout"));
        return true;
      }
    );

    const storedOutcome = store.getOutcome(101n, OutcomeAction.EXECUTE);
    assert.ok(storedOutcome);
    assert.strictEqual(storedOutcome.status, OutcomeStatus.FAILED);
    assert.strictEqual(storedOutcome.verifiedOnChain, false);
  });
});
