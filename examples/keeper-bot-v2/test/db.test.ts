import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { DatabaseClient } from "../src/db/client.js";
import { TaskStateStore } from "../src/db/store.js";

const dbUrl = process.env.DATABASE_URL || process.env.KEEPER_BOT_V2_TEST_DATABASE_URL;

describe("Keeper Bot v2 Database Persistent Store (PostgreSQL)", () => {
  if (!dbUrl) {
    it("skips when DATABASE_URL is not set", () => {
      console.log("NOTE: DATABASE_URL is unset; skipping database-backed integration tests.");
      assert.ok(true);
    });
    return;
  }

  let dbClient: DatabaseClient;
  let store: TaskStateStore;

  before(async () => {
    dbClient = new DatabaseClient(dbUrl);
    store = new TaskStateStore(dbClient);
    await store.init();
  });

  after(async () => {
    if (dbClient) {
      // Clean up test records
      try {
        await dbClient.query("DELETE FROM keeper_task_outcomes WHERE task_id IN (999001, 999002, 999003)");
      } catch {
        // ignore cleanup errors
      }
      await dbClient.close();
    }
  });

  it("creates tables and executes idempotent schema migrations", async () => {
    // Calling init() a second time should not fail
    await assert.doesNotReject(async () => {
      await store.init();
    });
  });

  it("records claim and execution outcomes idempotently", async () => {
    const taskId = 999001n;
    const keeper = "GBGWKM3CD4IL47QN6X54N6Y33T3JDNVI6AIJ6CD5IM47HG3IG4O36XCU";

    await store.recordClaim(taskId, "contract_invocation", keeper);
    let outcome = await store.getOutcome(taskId);
    assert.ok(outcome);
    assert.strictEqual(outcome.status, "claimed");
    assert.strictEqual(outcome.keeperAddress, keeper);

    // Update to executed
    await store.recordExecution(taskId, "contract_invocation", keeper, 500000n);
    outcome = await store.getOutcome(taskId);
    assert.ok(outcome);
    assert.strictEqual(outcome.status, "executed");
    assert.strictEqual(outcome.profitStroops, 500000n);

    // Check processed helper
    const processed = await store.isTaskProcessed(taskId);
    assert.strictEqual(processed, true);
  });

  it("records skip decisions with specific reasons", async () => {
    const taskId = 999002n;
    await store.recordSkip(taskId, "liquidation", "unprofitable");

    const outcome = await store.getOutcome(taskId);
    assert.ok(outcome);
    assert.strictEqual(outcome.status, "skipped");
    assert.strictEqual(outcome.skipReason, "unprofitable");

    const processed = await store.isTaskProcessed(taskId);
    assert.strictEqual(processed, true);
  });

  it("survives restart and reloads all processed task IDs", async () => {
    const processedSet = await store.loadProcessedTaskIds();
    assert.ok(processedSet.has(999001n), "Must retain previously executed task across instances");
    assert.ok(processedSet.has(999002n), "Must retain previously skipped task across instances");
  });
});
