"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  WithdrawalStrategy,
  FixedThresholdStrategy,
  FixedScheduleStrategy,
  FeeAwareThresholdStrategy,
  WithdrawalManager,
} = require("../src/withdrawal.js");

describe("Pluggable Withdrawal Strategy (Issue #400)", () => {
  describe("FixedThresholdStrategy (v1 default parity)", () => {
    it("matches v1 threshold behavior exactly", () => {
      const threshold = 10000000n; // 1 XLM in stroops
      const strategy = new FixedThresholdStrategy(threshold);

      // Balance strictly below threshold: no withdrawal
      const below = strategy.evaluate({ balance: 9999999n });
      assert.equal(below.shouldWithdraw, false);
      assert.match(below.reason, /below threshold/);

      // Balance exactly at threshold: triggers withdrawal (exact v1 match)
      const exact = strategy.evaluate({ balance: 10000000n });
      assert.equal(exact.shouldWithdraw, true);
      assert.match(exact.reason, /meets or exceeds threshold/);

      // Balance above threshold: triggers withdrawal
      const above = strategy.evaluate({ balance: 50000000n });
      assert.equal(above.shouldWithdraw, true);
    });

    it("defaults to 10_000_000 stroops (1 XLM) when threshold omitted", () => {
      const strategy = new FixedThresholdStrategy();
      assert.equal(strategy.evaluate({ balance: 9999999n }).shouldWithdraw, false);
      assert.equal(strategy.evaluate({ balance: 10000000n }).shouldWithdraw, true);
    });

    it("WithdrawalManager defaults to FixedThresholdStrategy preserving v1 zero-config migration", () => {
      const manager = new WithdrawalManager();
      assert.equal(manager.shouldWithdraw({ balance: 5000000n }).shouldWithdraw, false);
      assert.equal(manager.shouldWithdraw({ balance: 10000000n }).shouldWithdraw, true);
    });
  });

  describe("FixedScheduleStrategy (reference alternative)", () => {
    it("triggers withdrawal only after schedule interval elapses with balance", () => {
      const strategy = new FixedScheduleStrategy({
        intervalSeconds: 3600, // 1 hour
        lastWithdrawalTimestamp: 1000,
        minBalance: 1000n,
      });

      // No balance: should not withdraw even if time has elapsed
      const noBal = strategy.evaluate({ balance: 0n, currentTimestamp: 5000 });
      assert.equal(noBal.shouldWithdraw, false);
      assert.match(noBal.reason, /below minimum required/);

      // Time not elapsed (30 mins): should not withdraw
      const notDue = strategy.evaluate({ balance: 50000n, currentTimestamp: 2800 });
      assert.equal(notDue.shouldWithdraw, false);
      assert.match(notDue.reason, /scheduled interval not reached/);

      // Time elapsed (1 hr exactly): triggers withdrawal
      const due = strategy.evaluate({ balance: 50000n, currentTimestamp: 4600 });
      assert.equal(due.shouldWithdraw, true);
      assert.match(due.reason, /scheduled interval elapsed/);

      // After recording withdrawal, resets window
      strategy.recordWithdrawal(4600);
      assert.equal(strategy.evaluate({ balance: 50000n, currentTimestamp: 4650 }).shouldWithdraw, false);
    });
  });

  describe("FeeAwareThresholdStrategy (gas-adaptive alternative)", () => {
    it("lowers withdrawal threshold during low-fee windows", () => {
      const strategy = new FeeAwareThresholdStrategy({
        normalThreshold: 10000000n, // 1 XLM
        lowFeeThreshold: 2000000n,  // 0.2 XLM
        lowFeeCutoff: 100,          // 100 stroops
      });

      // Low base fee (100 stroops): 2 XLM balance triggers withdrawal
      const lowFeeWindow = strategy.evaluate({ balance: 2500000n, baseFee: 100 });
      assert.equal(lowFeeWindow.shouldWithdraw, true);
      assert.match(lowFeeWindow.reason, /meets low-fee threshold/);

      // High base fee (500 stroops): same balance is denied because normal threshold applies
      const congested = strategy.evaluate({ balance: 2500000n, baseFee: 500 });
      assert.equal(congested.shouldWithdraw, false);
      assert.match(congested.reason, /below standard threshold/);
    });
  });

  describe("Interface Pluggability", () => {
    it("confirms the interface is genuinely pluggable with a custom 3rd-party strategy", () => {
      // Simulate an operator-supplied strategy: e.g. Tax/Treasury Epoch Strategy
      class CustomTreasuryEpochStrategy extends WithdrawalStrategy {
        constructor(activeEpoch) {
          super();
          this.activeEpoch = activeEpoch;
        }

        evaluate({ balance, currentLedger }) {
          // Custom rule: only withdraw if ledger sequence is in a designated reconciliation epoch window
          const isEpochWindow = currentLedger % 1000 < 50;
          const hasSufficientDust = BigInt(balance) >= 500000n;

          if (isEpochWindow && hasSufficientDust) {
            return {
              shouldWithdraw: true,
              reason: `custom treasury reconciliation window active at ledger ${currentLedger}`,
            };
          }
          return {
            shouldWithdraw: false,
            reason: `outside custom epoch reconciliation window (ledger ${currentLedger})`,
          };
        }
      }

      const customStrategy = new CustomTreasuryEpochStrategy("epoch-2026-Q3");
      const manager = new WithdrawalManager();
      manager.setStrategy(customStrategy);

      // At ledger 1020 (within 0-49 epoch window) with 500k stroops -> withdraw
      const inWindow = manager.shouldWithdraw({ balance: 600000n, currentLedger: 1020 });
      assert.equal(inWindow.shouldWithdraw, true);
      assert.match(inWindow.reason, /custom treasury reconciliation window active/);

      // At ledger 1080 (outside epoch window) -> do not withdraw
      const outWindow = manager.shouldWithdraw({ balance: 600000n, currentLedger: 1080 });
      assert.equal(outWindow.shouldWithdraw, false);
    });

    it("rejects strategies not conforming to the evaluate interface", () => {
      const manager = new WithdrawalManager();
      assert.throws(
        () => manager.setStrategy({ notEvaluate: () => {} }),
        /must be an object with an evaluate\(context\) method/
      );
      assert.throws(
        () => manager.setStrategy(null),
        /Invalid withdrawal strategy/
      );
    });
  });
});
