/**
 * Test suite for withRetry()
 *
 * The retry mechanism is critical for keeper reliability. It must:
 *   - Retry transient failures with exponential backoff
 *   - Apply jitter to avoid thundering herd
 *   - Abort immediately on permanent errors
 *   - Respect the maximum retry limit
 *
 * Tests must run quickly, so we inject a fake timer instead of actually waiting.
 */

"use strict";

const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert");

// We need to test withRetry, but it depends on CONFIG which is set during
// validateAndLoadConfig(). For testing, we'll set up a minimal CONFIG.
let originalConfig;

beforeEach(() => {
  // Save original CONFIG if it exists
  originalConfig = global.CONFIG;
  
  // Set up test CONFIG
  delete require.cache[require.resolve("../index.js")];
  const keeper = require("../index.js");
  
  // Mock CONFIG for testing
  global.CONFIG = {
    maxRetries: 3,
    retryBaseMs: 100,
  };
});

describe("withRetry", () => {
  describe("success cases", () => {
    it("returns immediately on first success", async () => {
      const keeper = require("../index.js");
      const fn = async () => "success";
      const result = await keeper.withRetry("test-op", fn);
      assert.strictEqual(result, "success");
    });

    it("returns result from successful retry", async () => {
      const keeper = require("../index.js");
      let attempts = 0;
      const fn = async () => {
        attempts++;
        if (attempts < 2) throw new Error("transient failure");
        return "eventually succeeded";
      };
      const result = await keeper.withRetry("test-op", fn);
      assert.strictEqual(result, "eventually succeeded");
      assert.strictEqual(attempts, 2);
    });

    it("succeeds on last allowed attempt", async () => {
      const keeper = require("../index.js");
      let attempts = 0;
      const fn = async () => {
        attempts++;
        if (attempts <= 3) throw new Error("transient failure");
        return "success";
      };
      const result = await keeper.withRetry("test-op", fn);
      assert.strictEqual(result, "success");
      assert.strictEqual(attempts, 4); // Initial + 3 retries
    });
  });

  describe("retry exhaustion", () => {
    it("throws after maxRetries attempts", async () => {
      const keeper = require("../index.js");
      let attempts = 0;
      const fn = async () => {
        attempts++;
        throw new Error("persistent transient failure");
      };
      
      await assert.rejects(
        async () => keeper.withRetry("test-op", fn),
        {
          message: "persistent transient failure",
        }
      );
      assert.strictEqual(attempts, 4); // Initial + 3 retries
    });

    it("throws the last error encountered", async () => {
      const keeper = require("../index.js");
      const fn = async () => {
        throw new Error("final error");
      };
      
      await assert.rejects(
        async () => keeper.withRetry("test-op", fn),
        {
          message: "final error",
        }
      );
    });
  });

  describe("permanent errors", () => {
    it("does not retry on simulation failure", async () => {
      const keeper = require("../index.js");
      let attempts = 0;
      const fn = async () => {
        attempts++;
        throw new Error("Simulation failed: InvalidAction");
      };
      
      await assert.rejects(
        async () => keeper.withRetry("test-op", fn),
        {
          message: "Simulation failed: InvalidAction",
        }
      );
      assert.strictEqual(attempts, 1, "should not retry permanent errors");
    });

    it("does not retry on unauthorized error", async () => {
      const keeper = require("../index.js");
      let attempts = 0;
      const fn = async () => {
        attempts++;
        throw new Error("Unauthorized keeper");
      };
      
      await assert.rejects(
        async () => keeper.withRetry("test-op", fn),
        {
          message: "Unauthorized keeper",
        }
      );
      assert.strictEqual(attempts, 1);
    });

    it("does not retry on already claimed", async () => {
      const keeper = require("../index.js");
      let attempts = 0;
      const fn = async () => {
        attempts++;
        throw new Error("Task already claimed");
      };
      
      await assert.rejects(
        async () => keeper.withRetry("test-op", fn),
        {
          message: "Task already claimed",
        }
      );
      assert.strictEqual(attempts, 1);
    });
  });

  describe("exponential backoff", () => {
    it("applies exponential backoff across retries", async () => {
      const keeper = require("../index.js");
      const delays = [];
      const originalSleep = keeper.sleep;
      
      // Mock sleep to capture delays without actually waiting
      keeper.sleep = async (ms) => {
        delays.push(ms);
        return Promise.resolve();
      };

      let attempts = 0;
      const fn = async () => {
        attempts++;
        if (attempts <= 3) throw new Error("retry me");
        return "ok";
      };

      try {
        await keeper.withRetry("test-op", fn);
      } finally {
        keeper.sleep = originalSleep;
      }

      // Should have 3 delays (one before each retry)
      assert.strictEqual(delays.length, 3);
      
      // Each delay should be >= the base exponential value
      // Attempt 0 fails → delay >= 100 * 2^0 = 100
      // Attempt 1 fails → delay >= 100 * 2^1 = 200
      // Attempt 2 fails → delay >= 100 * 2^2 = 400
      assert.ok(delays[0] >= 100, `First delay ${delays[0]} should be >= 100`);
      assert.ok(delays[1] >= 200, `Second delay ${delays[1]} should be >= 200`);
      assert.ok(delays[2] >= 400, `Third delay ${delays[2]} should be >= 400`);
    });

    it("applies jitter within expected bounds", async () => {
      const keeper = require("../index.js");
      const delays = [];
      const originalSleep = keeper.sleep;
      
      keeper.sleep = async (ms) => {
        delays.push(ms);
        return Promise.resolve();
      };

      let attempts = 0;
      const fn = async () => {
        attempts++;
        if (attempts <= 2) throw new Error("retry me");
        return "ok";
      };

      try {
        await keeper.withRetry("test-op", fn);
      } finally {
        keeper.sleep = originalSleep;
      }

      // Jitter adds random [0, retryBaseMs) to the exponential backoff
      // So delay should be in range [base * 2^attempt, base * 2^attempt + base)
      for (let i = 0; i < delays.length; i++) {
        const minDelay = 100 * (2 ** i);
        const maxDelay = minDelay + 100;
        assert.ok(
          delays[i] >= minDelay && delays[i] < maxDelay,
          `Delay ${delays[i]} should be in range [${minDelay}, ${maxDelay})`
        );
      }
    });
  });

  describe("edge cases", () => {
    it("handles synchronous exceptions", async () => {
      const keeper = require("../index.js");
      const fn = () => {
        throw new Error("sync error");
      };
      
      await assert.rejects(
        async () => keeper.withRetry("test-op", fn),
        {
          message: "sync error",
        }
      );
    });

    it("handles rejected promises", async () => {
      const keeper = require("../index.js");
      const fn = async () => Promise.reject(new Error("rejected"));
      
      await assert.rejects(
        async () => keeper.withRetry("test-op", fn),
        {
          message: "rejected",
        }
      );
    });

    it("handles maxRetries = 0", async () => {
      const keeper = require("../index.js");
      global.CONFIG.maxRetries = 0;
      
      let attempts = 0;
      const fn = async () => {
        attempts++;
        throw new Error("no retries allowed");
      };
      
      await assert.rejects(
        async () => keeper.withRetry("test-op", fn),
        {
          message: "no retries allowed",
        }
      );
      assert.strictEqual(attempts, 1, "should attempt once with maxRetries=0");
    });
  });
});
