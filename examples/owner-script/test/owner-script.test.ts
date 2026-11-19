import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import type { TaskRegistryClient } from "../src/owner-script.ts";
import { runOwnerLifecycle } from "../src/owner-script.ts";

test("Criterion 1: Script is under 100 lines", () => {
  const filePath = path.join(process.cwd(), "src/owner-script.ts");
  const content = fs.readFileSync(filePath, "utf8");
  const lines = content.split("\n").length;

  console.log(`owner-script.ts total lines: ${lines}`);
  assert.ok(lines < 100, `Script must be under 100 lines, was ${lines}`);
  assert.ok(lines > 20, "Script must contain meaningful implementation");
});

test("Criterion 2: Handles the not-executed-before-deadline case", async () => {
  let ledger = 100;
  let cancelledTaskId: number | null = null;

  // Mock registry where no keeper executes before deadline
  const mockClient: TaskRegistryClient = {
    async getLatestLedger() {
      return ledger;
    },
    async registerTask(target, fn, reward, deadline) {
      return 42;
    },
    async getTask(id) {
      // Advance ledger on each poll until deadline expires
      ledger += 10;
      return { status: "PENDING", deadline: 120 };
    },
    async cancelTask(id) {
      cancelledTaskId = id;
      return 500_000n; // returns refunded stroops
    },
  };

  const result = await runOwnerLifecycle(
    mockClient,
    "CC_TARGET",
    "do_work",
    500_000n,
    20 // deadline = 100 + 20 = 120
  );

  // Verifies the not-executed-before-deadline case is properly handled:
  assert.equal(result.taskId, 42);
  assert.equal(result.status, "EXPIRED_AND_REFUNDED");
  assert.equal(result.refundedToOwner, true);
  assert.equal(cancelledTaskId, 42);
});

test("Success path: Handles task executed on time by keeper", async () => {
  let ledger = 500;
  let pollCount = 0;

  const mockClient: TaskRegistryClient = {
    async getLatestLedger() {
      return ledger;
    },
    async registerTask() {
      return 99;
    },
    async getTask(id) {
      pollCount++;
      if (pollCount >= 2) {
        return { status: "EXECUTED", keeper: "GD_KEEPER_BOT", deadline: 550 };
      }
      return { status: "PENDING", deadline: 550 };
    },
    async cancelTask() {
      throw new Error("Should not cancel on success");
    },
  };

  const result = await runOwnerLifecycle(
    mockClient,
    "CC_TARGET",
    "maintain",
    100_000n,
    50
  );

  assert.equal(result.status, "EXECUTED");
  assert.equal(result.keeper, "GD_KEEPER_BOT");
});
