import test from "node:test";
import assert from "node:assert/strict";
import { SubscriptionManager } from "../src/subscription.ts";
import { TaskChainingAutomator } from "../scripts/register-next-task.ts";

test("Criterion 1: Contract refuses double payment within the same period", () => {
  const manager = new SubscriptionManager(1000);
  const subscriber = "GB_SUBSCRIBER_WALLET";
  const merchant = "GB_MERCHANT_WALLET";
  const token = "CA_USDC_TOKEN";
  const amount = 25_000_000n; // 2.5 USDC
  const interval = 100; // ledgers per billing period
  const maxPeriods = 6;

  const sub = manager.createSubscription(
    subscriber,
    merchant,
    token,
    amount,
    interval,
    maxPeriods
  );

  assert.equal(sub.id, 1);
  assert.equal(sub.paidPeriods, 0);

  // Attempting to execute payment early (ledger 1040 < 1100) must fail
  manager.advanceLedgers(40);
  assert.throws(
    () => manager.executePayment(sub.id),
    /DOUBLE_PAYMENT_REFUSED/,
    "Payment before interval must be refused"
  );

  // Advance to ledger 1100 (due ledger for Period 1)
  manager.advanceLedgers(60);
  assert.equal(manager.getCurrentLedger(), 1100);

  const res1 = manager.executePayment(sub.id);
  assert.equal(res1.periodPaid, 1);
  assert.equal(res1.amount, amount);
  assert.equal(res1.executionLedger, 1100);
  assert.equal(res1.nextDueLedger, 1200);

  // CRITICAL CHECK: Contract REFUSES double payment within the same period
  // 1. Immediately at ledger 1100
  assert.throws(
    () => manager.executePayment(sub.id),
    /DOUBLE_PAYMENT_REFUSED.*wait 100 more ledgers/,
    "Immediate second payment in same period must be refused"
  );

  // 2. Mid-period at ledger 1150
  manager.advanceLedgers(50);
  assert.equal(manager.getCurrentLedger(), 1150);
  assert.throws(
    () => manager.executePayment(sub.id),
    /DOUBLE_PAYMENT_REFUSED.*wait 50 more ledgers/,
    "Mid-period second payment must be refused"
  );

  // 3. Just before period 2 at ledger 1199
  manager.advanceLedgers(49);
  assert.equal(manager.getCurrentLedger(), 1199);
  assert.throws(
    () => manager.executePayment(sub.id),
    /DOUBLE_PAYMENT_REFUSED.*wait 1 more ledgers/,
    "Payment at ledger 1199 must be refused"
  );

  // Exactly at ledger 1200, Period 2 succeeds!
  manager.advanceLedgers(1);
  assert.equal(manager.getCurrentLedger(), 1200);
  const res2 = manager.executePayment(sub.id);
  assert.equal(res2.periodPaid, 2);
});

test("Criterion 2: Script registers the next period's task after each execution", () => {
  const manager = new SubscriptionManager(2000);
  const automator = new TaskChainingAutomator("CC_SUBSCRIPTION_CONTRACT");

  const sub = manager.createSubscription(
    "GB_USER",
    "GB_SAAS_MERCHANT",
    "CA_EURC",
    10_000_000n,
    200, // 200 ledgers interval
    3 // 3 total periods
  );

  // --- Period 1 Execution ---
  manager.advanceLedgers(200);
  const payment1 = manager.executePayment(sub.id);

  // Script triggers on payment 1 completed:
  const task2 = automator.onPaymentExecuted(payment1, sub);
  assert.ok(task2, "Next task for period 2 must be registered");
  assert.equal(task2.subscriptionId, sub.id);
  assert.equal(task2.period, 2);
  assert.equal(task2.dueLedger, 2400); // 2200 + 200 = 2400
  assert.equal(task2.functionName, "execute_payment");
  assert.deepEqual(task2.args, [sub.id]);

  // --- Period 2 Execution ---
  manager.advanceLedgers(200);
  const payment2 = manager.executePayment(sub.id);

  // Script triggers on payment 2 completed:
  const task3 = automator.onPaymentExecuted(payment2, sub);
  assert.ok(task3, "Next task for period 3 must be registered");
  assert.equal(task3.period, 3);
  assert.equal(task3.dueLedger, 2600);

  // --- Period 3 Execution (Final) ---
  manager.advanceLedgers(200);
  const payment3 = manager.executePayment(sub.id);
  assert.equal(sub.active, false); // reached maxPeriods (3)

  // Script triggers on payment 3 completed:
  const finalTask = automator.onPaymentExecuted(payment3, sub);
  assert.equal(finalTask, null, "No task should be registered once max periods are reached");

  // Total chained tasks = 2 (period 2 task, period 3 task)
  assert.equal(automator.getRegisteredTasks().length, 2);
});
