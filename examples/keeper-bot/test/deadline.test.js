/**
 * Test suite for deadline logic in keeperLoop()
 *
 * The keeper must make the correct decision when evaluating each task:
 *   - CLAIM: deadline is in the future
 *   - EXPIRE: deadline has passed (and EXPIRE_STALE_TASKS is true)
 *   - SKIP: deadline has passed (and EXPIRE_STALE_TASKS is false)
 *
 * Boundary conditions around nowSeconds must be tested to catch off-by-one errors.
 */

"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");

/**
 * Helper function to test deadline decision logic.
 * Extracted from keeperLoop for isolated testing.
 */
function shouldClaimTask(deadline, nowSeconds) {
  return deadline > nowSeconds;
}

function shouldExpireTask(deadline, nowSeconds, expireStaleTasks) {
  return deadline <= nowSeconds && expireStaleTasks;
}

function shouldSkipTask(deadline, nowSeconds, expireStaleTasks) {
  return deadline <= nowSeconds && !expireStaleTasks;
}

describe("deadline logic", () => {
  describe("claim decision", () => {
    it("claims task when deadline is in future", () => {
      const nowSeconds = 1000;
      const deadline = 2000;
      assert.strictEqual(shouldClaimTask(deadline, nowSeconds), true);
    });

    it("claims task when deadline is far in future", () => {
      const nowSeconds = 1000;
      const deadline = 10000;
      assert.strictEqual(shouldClaimTask(deadline, nowSeconds), true);
    });

    it("claims task when deadline is 1 second in future", () => {
      const nowSeconds = 1000;
      const deadline = 1001;
      assert.strictEqual(shouldClaimTask(deadline, nowSeconds), true);
    });

    it("does not claim when deadline equals now", () => {
      const nowSeconds = 1000;
      const deadline = 1000;
      assert.strictEqual(shouldClaimTask(deadline, nowSeconds), false);
    });

    it("does not claim when deadline is in past", () => {
      const nowSeconds = 2000;
      const deadline = 1000;
      assert.strictEqual(shouldClaimTask(deadline, nowSeconds), false);
    });
  });

  describe("expire decision (with expireStaleTasks = true)", () => {
    const expireStaleTasks = true;

    it("expires task when deadline equals now", () => {
      const nowSeconds = 1000;
      const deadline = 1000;
      assert.strictEqual(shouldExpireTask(deadline, nowSeconds, expireStaleTasks), true);
    });

    it("expires task when deadline is in past", () => {
      const nowSeconds = 2000;
      const deadline = 1000;
      assert.strictEqual(shouldExpireTask(deadline, nowSeconds, expireStaleTasks), true);
    });

    it("expires task when deadline is 1 second in past", () => {
      const nowSeconds = 1001;
      const deadline = 1000;
      assert.strictEqual(shouldExpireTask(deadline, nowSeconds, expireStaleTasks), true);
    });

    it("does not expire when deadline is in future", () => {
      const nowSeconds = 1000;
      const deadline = 2000;
      assert.strictEqual(shouldExpireTask(deadline, nowSeconds, expireStaleTasks), false);
    });
  });

  describe("skip decision (with expireStaleTasks = false)", () => {
    const expireStaleTasks = false;

    it("skips task when deadline equals now", () => {
      const nowSeconds = 1000;
      const deadline = 1000;
      assert.strictEqual(shouldSkipTask(deadline, nowSeconds, expireStaleTasks), true);
    });

    it("skips task when deadline is in past", () => {
      const nowSeconds = 2000;
      const deadline = 1000;
      assert.strictEqual(shouldSkipTask(deadline, nowSeconds, expireStaleTasks), true);
    });

    it("does not skip when deadline is in future", () => {
      const nowSeconds = 1000;
      const deadline = 2000;
      assert.strictEqual(shouldSkipTask(deadline, nowSeconds, expireStaleTasks), false);
    });
  });

  describe("boundary conditions", () => {
    it("handles deadline at exact timestamp boundary", () => {
      const nowSeconds = 1735689600; // 2025-01-01 00:00:00 UTC
      const deadline = 1735689600;
      
      assert.strictEqual(shouldClaimTask(deadline, nowSeconds), false);
      assert.strictEqual(shouldExpireTask(deadline, nowSeconds, true), true);
    });

    it("handles deadline one second before now", () => {
      const nowSeconds = 1735689600;
      const deadline = 1735689599;
      
      assert.strictEqual(shouldClaimTask(deadline, nowSeconds), false);
      assert.strictEqual(shouldExpireTask(deadline, nowSeconds, true), true);
    });

    it("handles deadline one second after now", () => {
      const nowSeconds = 1735689600;
      const deadline = 1735689601;
      
      assert.strictEqual(shouldClaimTask(deadline, nowSeconds), true);
      assert.strictEqual(shouldExpireTask(deadline, nowSeconds, true), false);
    });

    it("handles very large timestamps", () => {
      const nowSeconds = 2147483647; // Max 32-bit timestamp
      const deadline = 2147483648;
      
      assert.strictEqual(shouldClaimTask(deadline, nowSeconds), true);
    });

    it("handles zero timestamp", () => {
      const nowSeconds = 100;
      const deadline = 0;
      
      assert.strictEqual(shouldClaimTask(deadline, nowSeconds), false);
      assert.strictEqual(shouldExpireTask(deadline, nowSeconds, true), true);
    });
  });

  describe("off-by-one scenarios", () => {
    it("does not claim task at exact deadline (not off-by-one)", () => {
      // This catches the common mistake: deadline >= nowSeconds
      // Correct logic: deadline > nowSeconds
      const nowSeconds = 1000;
      const deadline = 1000;
      assert.strictEqual(shouldClaimTask(deadline, nowSeconds), false);
    });

    it("expires task at exact deadline (not off-by-one)", () => {
      // This catches: deadline < nowSeconds
      // Correct logic: deadline <= nowSeconds
      const nowSeconds = 1000;
      const deadline = 1000;
      assert.strictEqual(shouldExpireTask(deadline, nowSeconds, true), true);
    });

    it("claims task exactly one tick after deadline threshold", () => {
      const nowSeconds = 999;
      const deadline = 1000;
      assert.strictEqual(shouldClaimTask(deadline, nowSeconds), true);
    });

    it("expires task exactly one tick after deadline", () => {
      const nowSeconds = 1001;
      const deadline = 1000;
      assert.strictEqual(shouldExpireTask(deadline, nowSeconds, true), true);
    });
  });

  describe("decision matrix", () => {
    it("generates correct decision for all combinations", () => {
      const scenarios = [
        { deadline: 2000, now: 1000, expireStale: true, expected: "claim" },
        { deadline: 2000, now: 1000, expireStale: false, expected: "claim" },
        { deadline: 1000, now: 1000, expireStale: true, expected: "expire" },
        { deadline: 1000, now: 1000, expireStale: false, expected: "skip" },
        { deadline: 500, now: 1000, expireStale: true, expected: "expire" },
        { deadline: 500, now: 1000, expireStale: false, expected: "skip" },
        { deadline: 1001, now: 1000, expireStale: true, expected: "claim" },
        { deadline: 1001, now: 1000, expireStale: false, expected: "claim" },
      ];

      for (const scenario of scenarios) {
        const claim = shouldClaimTask(scenario.deadline, scenario.now);
        const expire = shouldExpireTask(scenario.deadline, scenario.now, scenario.expireStale);
        const skip = shouldSkipTask(scenario.deadline, scenario.now, scenario.expireStale);

        let actual = "none";
        if (claim) actual = "claim";
        else if (expire) actual = "expire";
        else if (skip) actual = "skip";

        assert.strictEqual(
          actual,
          scenario.expected,
          `Failed for deadline=${scenario.deadline}, now=${scenario.now}, expireStale=${scenario.expireStale}`
        );
      }
    });
  });
});
