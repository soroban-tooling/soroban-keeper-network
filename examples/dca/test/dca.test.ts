import test from "node:test";
import assert from "node:assert/strict";
import { DcaManager } from "../src/dca.ts";
import { buildDcaKeeperTask, buildCancelDcaTaskPayload } from "../scripts/dca-controller.ts";

test("Criterion 1: Each period swaps a fixed amount, strictly enforced on-chain", () => {
  const manager = new DcaManager(1000);
  const owner = "GB_DCA_INVESTOR";

  const totalDeposit = 10_000n; // 10,000 USDC
  const fixedSwapAmount = 2_000n; // exactly 2,000 USDC per swap (5 swaps total)
  const interval = 100; // ledgers

  manager.setBalance(owner, totalDeposit);

  const plan = manager.createDcaPlan(
    owner,
    "CA_USDC",
    "CA_XLM",
    totalDeposit,
    fixedSwapAmount,
    interval
  );

  assert.equal(plan.remainingDeposit, 10_000n);
  assert.equal(plan.fixedSwapAmount, 2_000n);

  // Period 1 Swap (at ledger 1100)
  manager.advanceLedgers(100);
  const swap1 = manager.executeDcaSwap(plan.id);

  // Enforced fixed amount check:
  assert.equal(swap1.amountInSwapped, 2_000n);
  assert.equal(swap1.remainingBalance, 8_000n); // 10,000 - 2,000
  assert.equal(manager.getBalance(`${owner}:CA_XLM`), 4_000n); // 2,000 * 2.0

  // Premature swap attempt in same period must be refused
  manager.advanceLedgers(20);
  assert.throws(
    () => manager.executeDcaSwap(plan.id),
    /SWAP_NOT_DUE_YET/,
    "Premature swap before interval must be refused"
  );

  // Period 2 Swap (at ledger 1200)
  manager.advanceLedgers(80);
  const swap2 = manager.executeDcaSwap(plan.id);
  assert.equal(swap2.amountInSwapped, 2_000n); // exactly fixed 2,000
  assert.equal(swap2.remainingBalance, 6_000n);

  // Period 3 Swap (at ledger 1300)
  manager.advanceLedgers(100);
  const swap3 = manager.executeDcaSwap(plan.id);
  assert.equal(swap3.amountInSwapped, 2_000n);
  assert.equal(swap3.remainingBalance, 4_000n);
});

test("Criterion 2: The owner can stop the schedule by cancelling the pending task", () => {
  const manager = new DcaManager(2000);
  const owner = "GB_ALICE";

  const totalDeposit = 5_000n;
  const fixedSwap = 1_000n;
  manager.setBalance(owner, totalDeposit);

  const plan = manager.createDcaPlan(
    owner,
    "CA_TOKEN_A",
    "CA_TOKEN_B",
    totalDeposit,
    fixedSwap,
    50
  );

  // Execute Swap 1 (swaps 1,000, 4,000 remaining)
  manager.advanceLedgers(50);
  manager.executeDcaSwap(plan.id);
  assert.equal(plan.remainingDeposit, 4_000n);

  // Owner decides to stop the schedule!
  const cancelResult = manager.cancelDcaPlan(plan.id, owner);

  // Verifies schedule stopped and remaining 4,000 refunded to owner:
  assert.equal(cancelResult.refundedAmount, 4_000n);
  assert.equal(manager.getBalance(owner), 4_000n);
  assert.equal(manager.getPlan(plan.id).status, "CANCELLED");

  // Subsequent keeper swap attempts must be rejected
  manager.advanceLedgers(50);
  assert.throws(
    () => manager.executeDcaSwap(plan.id),
    /is not active \(status: CANCELLED\)/,
    "Keepers cannot execute a cancelled plan"
  );

  // Verify task controller generation
  const task = buildDcaKeeperTask("CC_DCA_ROUTER", plan);
  assert.equal(task.targetContract, "CC_DCA_ROUTER");
  assert.equal(task.fixedSwapAmount, "1000");

  const cancelPayload = buildCancelDcaTaskPayload("CC_DCA_ROUTER", plan.id);
  assert.equal(cancelPayload.functionName, "cancel_dca_plan");
  assert.deepEqual(cancelPayload.args, [plan.id]);
});
