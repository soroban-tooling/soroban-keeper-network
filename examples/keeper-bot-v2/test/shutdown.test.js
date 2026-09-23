"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { ShutdownCoordinator } = require("../src/shutdown.js");

const silentLogger = {
  log: () => {},
  warn: () => {},
  error: () => {},
};

describe("Graceful Shutdown Coordinator (Issue #402)", () => {
  it("waits for every in-flight concurrent worker, not just one", async () => {
    const coordinator = new ShutdownCoordinator({
      maxDrainMs: 2000,
      logger: silentLogger,
    });

    const completed = [];

    // Spin up 3 concurrent in-flight workers with staggered completion times
    const worker1 = coordinator.runWorker(async () => {
      await new Promise((res) => setTimeout(res, 50));
      completed.push("worker1");
      return "result1";
    });

    const worker2 = coordinator.runWorker(async () => {
      await new Promise((res) => setTimeout(res, 80));
      completed.push("worker2");
      return "result2";
    });

    const worker3 = coordinator.runWorker(async () => {
      await new Promise((res) => setTimeout(res, 30));
      completed.push("worker3");
      return "result3";
    });

    assert.equal(coordinator.getActiveCount(), 3);

    // Trigger shutdown while workers are in flight
    const shutdownPromise = coordinator.initiateShutdown("SIGINT");
    assert.equal(coordinator.shouldStop(), true);

    const shutdownResult = await shutdownPromise;

    // Verify all workers resolved and completed
    assert.equal(shutdownResult.timedOut, false);
    assert.equal(shutdownResult.drainedCount, 3);
    assert.equal(shutdownResult.remaining, 0);
    assert.equal(completed.length, 3);
    assert.deepEqual(completed.sort(), ["worker1", "worker2", "worker3"]);

    const [r1, r2, r3] = await Promise.all([worker1, worker2, worker3]);
    assert.equal(r1, "result1");
    assert.equal(r2, "result2");
    assert.equal(r3, "result3");
  });

  it("prevents workers from being killed mid-submission and lets each finish", async () => {
    const coordinator = new ShutdownCoordinator({
      maxDrainMs: 1000,
      logger: silentLogger,
    });

    let submissionPersisted = false;

    // Simulate task execution and outcome persistence
    coordinator.runWorker(async () => {
      // Step 1: In-flight submission
      await new Promise((res) => setTimeout(res, 40));
      // Step 2: Persistence step
      submissionPersisted = true;
    });

    // Initiate shutdown immediately after submission starts
    const shutdownPromise = coordinator.initiateShutdown("SIGTERM");

    await shutdownPromise;
    assert.equal(submissionPersisted, true, "Worker completed execution and persistence before shutdown finished");
  });

  it("enforces a bounded maximum drain time when a worker is stuck", async () => {
    const coordinator = new ShutdownCoordinator({
      maxDrainMs: 100, // short bounded drain time
      logger: silentLogger,
    });

    let stuckWorkerUnblocked = false;

    // Worker 1: finishes quickly
    coordinator.runWorker(async () => {
      await new Promise((res) => setTimeout(res, 20));
      return "quick";
    });

    // Worker 2: simulates an indefinite hang / stuck network call
    coordinator.runWorker(async () => {
      await new Promise((res) => setTimeout(res, 500));
      stuckWorkerUnblocked = true;
    });

    assert.equal(coordinator.getActiveCount(), 2);

    const startTime = Date.now();
    const shutdownResult = await coordinator.initiateShutdown("SIGINT");
    const elapsed = Date.now() - startTime;

    assert.equal(shutdownResult.timedOut, true);
    assert.equal(shutdownResult.remaining, 1);
    assert.ok(elapsed >= 90 && elapsed <= 250, `Drain exited near maxDrainMs bound (took ${elapsed}ms)`);
    assert.equal(stuckWorkerUnblocked, false, "Did not wait indefinitely for stuck worker");
  });

  it("rejects new work once shutdown has been initiated", async () => {
    const coordinator = new ShutdownCoordinator({
      maxDrainMs: 1000,
      logger: silentLogger,
    });

    await coordinator.initiateShutdown("SIGTERM");

    // runWorker should return null
    const result = await coordinator.runWorker(async () => "never-run");
    assert.equal(result, null);

    // direct track() should throw error
    assert.throws(
      () => coordinator.track(Promise.resolve()),
      /Cannot start new work: shutdown already initiated/
    );
  });

  it("exits cleanly immediately when there are zero in-flight workers", async () => {
    const coordinator = new ShutdownCoordinator({
      maxDrainMs: 1000,
      logger: silentLogger,
    });

    const shutdownResult = await coordinator.initiateShutdown("MANUAL");
    assert.equal(shutdownResult.timedOut, false);
    assert.equal(shutdownResult.drainedCount, 0);
    assert.equal(shutdownResult.remaining, 0);
  });
});
