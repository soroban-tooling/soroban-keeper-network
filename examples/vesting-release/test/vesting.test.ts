import test from "node:test";
import assert from "node:assert/strict";
import { VestingManager } from "../src/vesting.ts";
import { generateVestingKeeperTasks } from "../scripts/register-vesting-tasks.ts";

test("Criterion 1: Releases before their date are strictly refused by the contract", () => {
  const start = 1_700_000_000;
  const interval = 30 * 86400; // 30 days
  const cliff = start + 6 * interval; // 6-month cliff (180 days)
  const totalTokens = 120_000_000_000n; // 12,000 tokens

  const manager = new VestingManager({
    beneficiary: "GB_BENEFICIARY_ADDRESS",
    token: "CA_GOV_TOKEN",
    totalAmount: totalTokens,
    startTimestamp: start,
    cliffTimestamp: cliff,
    numTranches: 12,
    trancheIntervalSeconds: interval,
  });

  // 1. Day 1: far before cliff -> contract must refuse release
  manager.setTimestamp(start + 86400);
  assert.throws(
    () => manager.release(),
    /CLIFF_NOT_REACHED/,
    "Contract must refuse release before cliff date"
  );

  // 2. Day 90: half-way to cliff -> contract must refuse release
  manager.setTimestamp(start + 90 * 86400);
  assert.throws(
    () => manager.release(),
    /CLIFF_NOT_REACHED/,
    "Contract must refuse release at Day 90"
  );

  // 3. Day 179: 1 hour before cliff -> contract must refuse release
  manager.setTimestamp(cliff - 3600);
  assert.throws(
    () => manager.release(),
    /CLIFF_NOT_REACHED/,
    "Contract must refuse release 1 hour before cliff"
  );

  // 4. Reach cliff date -> cliff release succeeds
  manager.setTimestamp(cliff);
  const cliffRes = manager.release();
  assert.equal(cliffRes.tranche, 6);
  assert.equal(cliffRes.amountReleased, 60_000_000_000n); // 50% = 6,000 tokens

  // 5. Day 195 (15 days after cliff, 15 days before Month 7 tranche):
  // Calling release between tranche dates must be refused by the contract!
  manager.setTimestamp(cliff + 15 * 86400);
  assert.throws(
    () => manager.release(),
    /TRANCHE_NOT_REACHED/,
    "Contract must refuse release between tranche dates"
  );
});

test("Criterion 2: Tests cover each tranche boundary across full vesting lifecycle", () => {
  const start = 1_700_000_000;
  const interval = 30 * 86400; // 30-day tranche
  const cliff = start + 3 * interval; // 3-month cliff
  const numTranches = 6;
  const totalTokens = 60_000_000_000n; // 6,000 tokens (1,000 per tranche)

  const config = {
    beneficiary: "GB_CORE_DEV",
    token: "CA_PLATFORM_TOKEN",
    totalAmount: totalTokens,
    startTimestamp: start,
    cliffTimestamp: cliff,
    numTranches,
    trancheIntervalSeconds: interval,
  };

  const manager = new VestingManager(config);

  // --- BOUNDARY 0: Before Cliff ---
  manager.setTimestamp(start + interval);
  assert.throws(() => manager.release(), /CLIFF_NOT_REACHED/);

  // --- BOUNDARY 1: Cliff (Tranches 1, 2, 3 unlock simultaneously) ---
  manager.setTimestamp(cliff);
  const rCliff = manager.release();
  assert.equal(rCliff.tranche, 3);
  assert.equal(rCliff.amountReleased, 30_000_000_000n); // 3,000 tokens
  assert.equal(manager.getReleasedAmount(), 30_000_000_000n);

  // --- BOUNDARY 2: Tranche 4 (Month 4) ---
  const t4Time = start + 4 * interval;
  manager.setTimestamp(t4Time);
  const r4 = manager.release();
  assert.equal(r4.tranche, 4);
  assert.equal(r4.amountReleased, 10_000_000_000n); // 1,000 tokens
  assert.equal(manager.getReleasedAmount(), 40_000_000_000n);

  // --- BOUNDARY 3: Tranche 5 (Month 5) ---
  const t5Time = start + 5 * interval;
  manager.setTimestamp(t5Time);
  const r5 = manager.release();
  assert.equal(r5.tranche, 5);
  assert.equal(r5.amountReleased, 10_000_000_000n);
  assert.equal(manager.getReleasedAmount(), 50_000_000_000n);

  // --- BOUNDARY 4: Tranche 6 (Month 6 - Final 100%) ---
  const t6Time = start + 6 * interval;
  manager.setTimestamp(t6Time);
  const r6 = manager.release();
  assert.equal(r6.tranche, 6);
  assert.equal(r6.amountReleased, 10_000_000_000n);
  assert.equal(manager.getReleasedAmount(), 60_000_000_000n); // 100% complete

  // --- POST-COMPLETION: Month 7 ---
  manager.setTimestamp(start + 7 * interval);
  assert.throws(
    () => manager.release(),
    /ALL_VESTED_ALREADY/,
    "Contract must refuse further releases once all tokens are vested"
  );

  // Verify keeper tasks generation covers cliff + every tranche
  const tasks = generateVestingKeeperTasks("CC_VESTING_CONTRACT", config);
  assert.equal(tasks.length, 4); // Cliff (tranches 1-3) + Tranche 4 + Tranche 5 + Tranche 6
  assert.equal(tasks[0].milestone, "cliff");
  assert.equal(tasks[0].triggerTimestamp, cliff);
  assert.equal(tasks[1].milestone, "tranche-4");
  assert.equal(tasks[2].milestone, "tranche-5");
  assert.equal(tasks[3].milestone, "tranche-6");
});
