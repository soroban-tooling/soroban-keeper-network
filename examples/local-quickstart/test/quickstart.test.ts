import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { QuickstartEngine } from "../src/quickstart-engine.ts";

test("Criterion 1: One command reaches a state where the bot executes the demo task", async () => {
  const tempStateFile = path.join(
    process.cwd(),
    `.test-quickstart-${Date.now()}.json`
  );

  try {
    const engine = new QuickstartEngine(tempStateFile);
    const result = await engine.run();

    // 1. Reaches EXECUTED state
    assert.equal(result.taskStatus, "EXECUTED");
    assert.equal(result.taskId, 1);
    assert.equal(result.isReRun, false);

    // 2. Verified reward payout & protocol fee settlement
    assert.equal(result.keeperRewardReceivedStroops, 9_700_000n); // 0.97 XLM
    assert.equal(result.protocolFeeRetainedStroops, 300_000n); // 0.03 XLM (3%)

    // 3. Execution logs contain full state transition
    const logText = result.logs.join("\n");
    assert.match(logText, /PENDING -> CLAIMED -> EXECUTED/);
    assert.match(logText, /Quickstart completed successfully/);
  } finally {
    if (fs.existsSync(tempStateFile)) {
      fs.unlinkSync(tempStateFile);
    }
  }
});

test("Criterion 2: The script prints every contract ID and is safe to re-run", async () => {
  const tempStateFile = path.join(
    process.cwd(),
    `.test-quickstart-rerun-${Date.now()}.json`
  );

  try {
    // --- First Run ---
    const engine1 = new QuickstartEngine(tempStateFile);
    const result1 = await engine1.run();

    // Verify all contract IDs are populated and printed
    assert.ok(result1.contracts.rewardTokenId.startsWith("C"));
    assert.ok(result1.contracts.registryId.startsWith("C"));
    assert.ok(result1.contracts.demoTargetId.startsWith("C"));

    const logs1 = result1.logs.join("\n");
    assert.match(logs1, /REWARD_TOKEN_ID:\s+CDLZFC3SY/);
    assert.match(logs1, /REGISTRY_ID:\s+CDJOYHBS7/);
    assert.match(logs1, /DEMO_TARGET_ID:\s+CCDEMOTARGET/);

    // --- Second Run (Re-run) ---
    // Safe to re-run: must not crash, must reuse existing contracts, must increment task ID
    const engine2 = new QuickstartEngine(tempStateFile);
    const result2 = await engine2.run();

    assert.equal(result2.isReRun, true);
    assert.equal(result2.taskId, 2); // incremental task created on re-run
    assert.equal(result2.taskStatus, "EXECUTED");
    assert.deepEqual(result2.contracts, result1.contracts);

    const logs2 = result2.logs.join("\n");
    assert.match(logs2, /Detected existing deployment state \(Safe Re-run mode\)/);
    assert.match(logs2, /Registering demo automation task #2/);
    assert.match(logs2, /REWARD_TOKEN_ID:\s+CDLZFC3SY/);
  } finally {
    if (fs.existsSync(tempStateFile)) {
      fs.unlinkSync(tempStateFile);
    }
  }
});
