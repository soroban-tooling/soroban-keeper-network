import test from "node:test";
import assert from "node:assert/strict";
import { TtlExtensionManager } from "../src/ttl-extension.ts";
import { buildTtlTaskRegistration } from "../scripts/register-ttl-task.ts";

test("Criterion 1: Storage expires naturally without keeper intervention", () => {
  const manager = new TtlExtensionManager(1000);
  const key = "user_pool_data";
  const naturalTtl = 100; // expires after 100 ledgers

  manager.registerEntry(key, { balance: 5000 }, 128, naturalTtl);

  // Check state at ledger 1050 (50 ledgers elapsed)
  manager.advanceLedgers(50);
  const entryBefore = manager.getEntry(key);
  assert.equal(entryBefore.currentTtlLedgers, 50);
  assert.equal(entryBefore.isArchived, false);

  // Advance past natural TTL (+60 ledgers -> 110 total)
  manager.advanceLedgers(60);
  assert.throws(
    () => manager.getEntry(key),
    /is ARCHIVED/,
    "Unextended storage must be archived past natural TTL"
  );
});

test("Criterion 1: Storage stays live past its natural TTL with keeper extension", () => {
  const manager = new TtlExtensionManager(1000);
  const key = "governance_vault_data";
  const naturalTtl = 100; // natural lifetime is 100 ledgers (1000 -> 1100)

  manager.registerEntry(key, { activeProposals: 3 }, 256, naturalTtl);

  // Advance 70 ledgers to ledger 1070 (remaining TTL = 30)
  manager.advanceLedgers(70);
  assert.equal(manager.needsExtension(40), true);

  // Keeper triggers TTL extension: threshold = 40, extendTo = 200 ledgers
  const result = manager.executeKeeperExtension(40, 200);
  assert.equal(result.extended, true);
  assert.equal(result.entriesExtended, 1);
  assert.equal(result.newTtl, 200);

  // Now advance by 80 ledgers to ledger 1150
  // Note: Without keeper, storage would have died at ledger 1100!
  // At ledger 1150, it is 50 ledgers PAST its natural expiration!
  manager.advanceLedgers(80);

  const entry = manager.getEntry(key);
  assert.equal(entry.isArchived, false);
  assert.deepEqual(entry.data, { activeProposals: 3 });
  assert.equal(entry.currentTtlLedgers, 120); // 200 - 80 = 120 remaining
});

test("Criterion 1: Multiple recurring keeper cycles keep dApp state permanently live", () => {
  const manager = new TtlExtensionManager(1000);
  const key = "dapp_vital_state";
  manager.registerEntry(key, { status: "HEALTHY" }, 512, 100);

  // In each cycle, advance by 110 ledgers (when extendTo was 150, remaining TTL becomes 40 <= threshold 50)
  for (let cycle = 1; cycle <= 5; cycle++) {
    // Advance so remaining TTL drops below threshold 50
    const advanceAmount = cycle === 1 ? 60 : 110;
    manager.advanceLedgers(advanceAmount);

    assert.equal(manager.needsExtension(50), true);
    const res = manager.executeKeeperExtension(50, 150);
    assert.equal(res.extended, true);

    const entry = manager.getEntry(key);
    assert.equal(entry.isArchived, false);
    assert.deepEqual(entry.data, { status: "HEALTHY" });
  }

  assert.equal(manager.getExtensionHistory().length, 5);
  // Total ledgers advanced: 60 + 4 * 110 = 500 ledgers (5x natural TTL of 100!)
  assert.equal(manager.getCurrentLedger(), 1500);
});

test("Criterion 2: Owner cost model calculates rent, fees, and archival savings accurately", () => {
  const entrySize = 512; // bytes
  const ledgersToExtend = 10_000;
  const reward = 50_000n; // 0.005 XLM
  const gasFee = 15_000n; // 0.0015 XLM

  const cost = TtlExtensionManager.calculateCostModel(
    entrySize,
    ledgersToExtend,
    reward,
    gasFee
  );

  // Rent = (512 * 10000 * 25) / 10000 = 12,800 stroops
  assert.equal(cost.storageRentStroops, 12_800n);
  assert.equal(cost.keeperRewardStroops, 50_000n);
  assert.equal(cost.keeperGasFeeStroops, 15_000n);
  assert.equal(cost.totalCostStroops, 77_800n); // 0.00778 XLM

  // Compare against archival restoration costs (~228,000 stroops)
  assert.ok(cost.archivalRestorationComparison.savingsStroops > 0n);
  assert.ok(cost.archivalRestorationComparison.percentSaved > 50);

  // Verify task registration payload matches cost estimate
  const task = buildTtlTaskRegistration({
    contractAddress: "CC62EXAMPLE",
    thresholdLedgers: 500,
    extendToLedgers: 10_000,
    keeperRewardStroops: 50_000n,
    deadlineLedgers: 100,
    intervalLedgers: 5_000,
  });

  assert.equal(task.target, "CC62EXAMPLE");
  assert.equal(task.function, "extend_ttl");
  assert.equal(task.costEstimate.totalStroops, "71400");
});
