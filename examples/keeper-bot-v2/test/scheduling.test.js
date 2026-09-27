"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  computeUnlockLedger,
  LockWindowScheduler,
} = require("../src/scheduling.js");

const silentLogger = {
  log: () => {},
  warn: () => {},
  error: () => {},
};

describe("Lock-Window Aware Task Scheduling (Issue #399)", () => {
  describe("computeUnlockLedger", () => {
    it("computes unlock ledger correctly from claim_ledger and lock_ledgers", () => {
      // Contract math parity: claim_ledger + lock_ledgers
      const task = {
        taskId: "1",
        claim_ledger: 500,
        lock_ledgers: 60,
      };

      const unlockLedger = computeUnlockLedger(task);
      assert.equal(unlockLedger, 560);
    });

    it("supports camelCase task properties (claimLedger, lockLedgers)", () => {
      const task = {
        taskId: "2",
        claimLedger: 1000,
        lockLedgers: 120,
      };

      assert.equal(computeUnlockLedger(task), 1120);
    });

    it("rejects task with invalid or missing claim/lock ledgers", () => {
      assert.throws(
        () => computeUnlockLedger(null),
        /task object is required/
      );
      assert.throws(
        () => computeUnlockLedger({ claim_ledger: 0, lock_ledgers: 10 }),
        /Invalid claim_ledger/
      );
      assert.throws(
        () => computeUnlockLedger({ claim_ledger: 100, lock_ledgers: -5 }),
        /Invalid lock_ledgers/
      );
    });
  });

  describe("LockWindowScheduler tracking & targeted re-checks", () => {
    it("re-checks tracked locked task at or after its computed unlock point without needing full re-scan", () => {
      const scheduler = new LockWindowScheduler({ logger: silentLogger });

      const taskA = {
        taskId: "101",
        claim_ledger: 1000,
        lock_ledgers: 50, // unlocks at 1050
      };

      const taskB = {
        taskId: "102",
        claim_ledger: 1020,
        lock_ledgers: 100, // unlocks at 1120
      };

      scheduler.trackLockedTask(taskA);
      scheduler.trackLockedTask(taskB);

      assert.equal(scheduler.getTrackedCount(), 2);
      assert.equal(scheduler.isTracking("101"), true);
      assert.equal(scheduler.isTracking("102"), true);

      // Ledger 1040: neither is unlocked yet
      assert.deepEqual(scheduler.getDueTasks(1040), []);

      // Ledger 1049: 1 ledger before taskA unlocks (exclusive)
      assert.deepEqual(scheduler.getDueTasks(1049), []);

      // Ledger 1050: boundary check (inclusive >=): taskA unlocks!
      const dueAt1050 = scheduler.getDueTasks(1050);
      assert.equal(dueAt1050.length, 1);
      assert.equal(dueAt1050[0].taskId, "101");

      // Ledger 1120: both taskA and taskB are unlocked
      const dueAt1120 = scheduler.getDueTasks(1120);
      assert.equal(dueAt1120.length, 2);

      // Using popDueTasks removes due tasks so they are not processed multiple times
      const popped = scheduler.popDueTasks(1050);
      assert.equal(popped.length, 1);
      assert.equal(popped[0].taskId, "101");
      assert.equal(scheduler.isTracking("101"), false);
      assert.equal(scheduler.isTracking("102"), true);
    });

    it("allows untracking a task when claimed or resolved elsewhere", () => {
      const scheduler = new LockWindowScheduler({ logger: silentLogger });
      const task = { taskId: "201", claim_ledger: 100, lock_ledgers: 20 };
      scheduler.trackLockedTask(task);

      assert.equal(scheduler.isTracking("201"), true);
      scheduler.untrackTask("201");
      assert.equal(scheduler.isTracking("201"), false);
      assert.deepEqual(scheduler.getDueTasks(200), []);
    });
  });

  describe("Additive Scheduling with Regular Polling", () => {
    it("merges due tasks additively with freshly polled tasks, discovering new tasks normally", () => {
      const scheduler = new LockWindowScheduler({ logger: silentLogger });

      // Track an existing locked task that is due to unlock at ledger 800
      const lockedTask = {
        taskId: "300",
        claim_ledger: 750,
        lock_ledgers: 50,
      };
      scheduler.trackLockedTask(lockedTask);

      // Fresh polled tasks discovered during regular polling cycle
      const newlyPolledTask1 = { taskId: "401", status: "Pending" };
      const newlyPolledTask2 = { taskId: "402", status: "Pending" };

      // Current ledger is 805 (locked task #300 is due)
      const merged = scheduler.mergeCandidateTasks(
        [newlyPolledTask1, newlyPolledTask2],
        805
      );

      // merged must contain BOTH due task #300 and new polled tasks #401, #402
      assert.equal(merged.length, 3);
      const mergedIds = merged.map((t) => String(t.taskId));
      assert.ok(mergedIds.includes("300"), "Due task #300 is prioritized and included");
      assert.ok(mergedIds.includes("401"), "Newly polled task #401 is included");
      assert.ok(mergedIds.includes("402"), "Newly polled task #402 is included");

      // Once merged, task #300 is popped from tracked scheduler
      assert.equal(scheduler.isTracking("300"), false);
    });

    it("deduplicates candidate tasks if a due task is also discovered in regular poll", () => {
      const scheduler = new LockWindowScheduler({ logger: silentLogger });

      const dueTask = { taskId: "501", claim_ledger: 100, lock_ledgers: 10 };
      scheduler.trackLockedTask(dueTask);

      // Polling also happened to pick up task #501 and new task #502
      const polled = [
        { taskId: "501", status: "Pending" },
        { taskId: "502", status: "Pending" },
      ];

      const merged = scheduler.mergeCandidateTasks(polled, 115);

      assert.equal(merged.length, 2);
      const ids = merged.map((t) => String(t.taskId));
      assert.deepEqual(ids, ["501", "502"]);
    });
  });
});
