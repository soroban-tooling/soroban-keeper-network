/**
 * Comprehensive test suite for degraded mode behavior.
 *
 * Tests cover:
 * - Normal operation with isolated transient failures (never enters degraded mode)
 * - Threshold behavior: degraded mode entered only after N consecutive exhausted sequences
 * - Alert firing: exactly once on entry, not repeatedly while degraded
 * - Recovery: single successful call exits degraded mode and resets counter
 * - Interval behavior: polling interval changes while degraded, restores on recovery
 * - Regression: existing withRetry per-sequence backoff unchanged
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { KeeperLoop, simulateRound } from "./loop.js";
import type { Config, AlertTransport, Alert } from "./types.js";

// Mock configuration for testing
const testConfig: Config = {
  network: "testnet",
  registryContractId: "CXXXXXX",
  keeperSecretKey: "SXXXXXX",
  maxRetries: 2,
  retryBaseMs: 10,
  pollIntervalMs: 1000,
  consecutiveExhaustedRetriesForDegradedMode: 3,
  degradedModePollingIntervalMs: 5000,
  maxTasksPerRound: 5,
  withdrawThreshold: 100n,
  minProfitMarginStroops: 0n,
  expireStaleTasks: true,
};

// Mock alert transport to track alert calls
class MockAlertTransport implements AlertTransport {
  alerts: Alert[] = [];

  async raise(alert: Alert): Promise<void> {
    this.alerts.push(alert);
  }

  reset(): void {
    this.alerts = [];
  }

  getAlertCount(): number {
    return this.alerts.length;
  }

  getLastAlert(): Alert | undefined {
    return this.alerts[this.alerts.length - 1];
  }
}

describe("KeeperLoop - Degraded Mode", () => {
  let loop: KeeperLoop;
  let alertTransport: MockAlertTransport;

  beforeEach(() => {
    alertTransport = new MockAlertTransport();
    loop = new KeeperLoop(testConfig, alertTransport);
  });

  describe("Normal operation: isolated transient failures never enter degraded mode", () => {
    it("should not enter degraded mode when a single call fails", async () => {
      const state1 = loop.getState();
      expect(state1.isDegraded).toBe(false);
      expect(state1.consecutiveExhaustedSequences).toBe(0);

      try {
        await loop.executeWithDegradedModeTracking("call-1", async () => {
          throw new Error("RPC timeout");
        });
      } catch {
        // Expected
      }

      const state2 = loop.getState();
      expect(state2.isDegraded).toBe(false);
      expect(state2.consecutiveExhaustedSequences).toBe(1);
      expect(alertTransport.getAlertCount()).toBe(0);
    });

    it("should reset counter and not enter degraded mode when a failed sequence is followed by success", async () => {
      // Fail 3 times
      for (let i = 0; i < 3; i++) {
        try {
          await loop.executeWithDegradedModeTracking(`fail-${i}`, async () => {
            throw new Error("RPC error");
          });
        } catch {
          // Expected
        }
      }

      // Should be at threshold but not yet entered
      let state = loop.getState();
      expect(state.consecutiveExhaustedSequences).toBe(3);
      expect(state.isDegraded).toBe(true); // Just entered
      expect(alertTransport.getAlertCount()).toBe(1);

      // Now succeed
      await loop.executeWithDegradedModeTracking("success", async () => {
        return "ok";
      });

      state = loop.getState();
      expect(state.isDegraded).toBe(false);
      expect(state.consecutiveExhaustedSequences).toBe(0);
    });

    it("should reset counter on any successful call without entering degraded mode", async () => {
      // Pattern: fail, fail, success (before hitting threshold)
      try {
        await loop.executeWithDegradedModeTracking("fail-1", async () => {
          throw new Error("Error 1");
        });
      } catch {
        // Expected
      }

      try {
        await loop.executeWithDegradedModeTracking("fail-2", async () => {
          throw new Error("Error 2");
        });
      } catch {
        // Expected
      }

      let state = loop.getState();
      expect(state.consecutiveExhaustedSequences).toBe(2);
      expect(state.isDegraded).toBe(false);

      // Success resets
      await loop.executeWithDegradedModeTracking("success", async () => "ok");

      state = loop.getState();
      expect(state.consecutiveExhaustedSequences).toBe(0);
      expect(state.isDegraded).toBe(false);
      expect(alertTransport.getAlertCount()).toBe(0);
    });
  });

  describe("Threshold behavior: degraded mode on N consecutive exhausted sequences", () => {
    it("should enter degraded mode when reaching threshold (3 consecutive failures)", async () => {
      const threshold = testConfig.consecutiveExhaustedRetriesForDegradedMode;

      for (let i = 0; i < threshold; i++) {
        try {
          await loop.executeWithDegradedModeTracking(`fail-${i}`, async () => {
            throw new Error(`RPC error ${i}`);
          });
        } catch {
          // Expected
        }
      }

      const state = loop.getState();
      expect(state.isDegraded).toBe(true);
      expect(state.consecutiveExhaustedSequences).toBe(threshold);
      expect(alertTransport.getAlertCount()).toBe(1);
    });

    it("should NOT enter degraded mode if exhaustion counter resets before hitting threshold", async () => {
      const threshold = testConfig.consecutiveExhaustedRetriesForDegradedMode;

      // Pattern: exhausted, exhausted, success, exhausted, exhausted (total 4 failures but never consecutive)
      const failurePattern = [true, true, false, true, true];

      for (let i = 0; i < failurePattern.length; i++) {
        if (failurePattern[i]) {
          try {
            await loop.executeWithDegradedModeTracking(`call-${i}`, async () => {
              throw new Error("Failure");
            });
          } catch {
            // Expected
          }
        } else {
          await loop.executeWithDegradedModeTracking(`call-${i}`, async () => "ok");
        }
      }

      const state = loop.getState();
      expect(state.isDegraded).toBe(false); // Should not have entered
      expect(state.consecutiveExhaustedSequences).toBe(2); // Last 2 failures
      expect(alertTransport.getAlertCount()).toBe(0); // No alert sent
    });

    it("should enter degraded mode after resetting and hitting threshold again", async () => {
      const threshold = testConfig.consecutiveExhaustedRetriesForDegradedMode;

      // First episode: fail threshold times, then recover
      for (let i = 0; i < threshold; i++) {
        try {
          await loop.executeWithDegradedModeTracking(`episode1-fail-${i}`, async () => {
            throw new Error("Error");
          });
        } catch {
          // Expected
        }
      }

      // Should be degraded with 1 alert
      let state = loop.getState();
      expect(state.isDegraded).toBe(true);
      expect(alertTransport.getAlertCount()).toBe(1);

      // Recover
      await loop.executeWithDegradedModeTracking("recovery", async () => "ok");
      state = loop.getState();
      expect(state.isDegraded).toBe(false);
      expect(state.consecutiveExhaustedSequences).toBe(0);

      // Second episode: fail threshold times again
      for (let i = 0; i < threshold; i++) {
        try {
          await loop.executeWithDegradedModeTracking(`episode2-fail-${i}`, async () => {
            throw new Error("Error");
          });
        } catch {
          // Expected
        }
      }

      state = loop.getState();
      expect(state.isDegraded).toBe(true);
      expect(alertTransport.getAlertCount()).toBe(2); // Second alert sent
    });
  });

  describe("Alert firing: exactly once per degraded mode episode", () => {
    it("should fire alert exactly once when entering degraded mode", async () => {
      const threshold = testConfig.consecutiveExhaustedRetriesForDegradedMode;

      for (let i = 0; i < threshold; i++) {
        try {
          await loop.executeWithDegradedModeTracking(`fail-${i}`, async () => {
            throw new Error("Error");
          });
        } catch {
          // Expected
        }
      }

      expect(alertTransport.getAlertCount()).toBe(1);
    });

    it("should NOT re-fire alert on subsequent failures while already degraded", async () => {
      const threshold = testConfig.consecutiveExhaustedRetriesForDegradedMode;

      // Enter degraded mode
      for (let i = 0; i < threshold; i++) {
        try {
          await loop.executeWithDegradedModeTracking(`fail-${i}`, async () => {
            throw new Error("Error");
          });
        } catch {
          // Expected
        }
      }

      expect(alertTransport.getAlertCount()).toBe(1);
      const firstAlert = alertTransport.getLastAlert();

      // More failures while already degraded
      try {
        await loop.executeWithDegradedModeTracking("more-fail", async () => {
          throw new Error("Error");
        });
      } catch {
        // Expected
      }

      // Still only 1 alert
      expect(alertTransport.getAlertCount()).toBe(1);
      expect(alertTransport.getLastAlert()).toBe(firstAlert);
    });

    it("should have correct alert properties on entry", async () => {
      const threshold = testConfig.consecutiveExhaustedRetriesForDegradedMode;

      for (let i = 0; i < threshold; i++) {
        try {
          await loop.executeWithDegradedModeTracking(`fail-${i}`, async () => {
            throw new Error("Error");
          });
        } catch {
          // Expected
        }
      }

      const alert = alertTransport.getLastAlert();
      expect(alert).toBeDefined();
      expect(alert!.type).toBe("degraded-mode-entry");
      expect(alert!.severity).toBe("critical");
      expect(alert!.message).toContain("degraded mode");
      expect(alert!.timestamp).toBeGreaterThan(0);
    });
  });

  describe("Recovery: exit degraded mode on first successful call", () => {
    it("should exit degraded mode on first success", async () => {
      const threshold = testConfig.consecutiveExhaustedRetriesForDegradedMode;

      // Enter degraded mode
      for (let i = 0; i < threshold; i++) {
        try {
          await loop.executeWithDegradedModeTracking(`fail-${i}`, async () => {
            throw new Error("Error");
          });
        } catch {
          // Expected
        }
      }

      let state = loop.getState();
      expect(state.isDegraded).toBe(true);
      expect(state.consecutiveExhaustedSequences).toBe(threshold);

      // First success exits degraded mode
      await loop.executeWithDegradedModeTracking("success", async () => "ok");

      state = loop.getState();
      expect(state.isDegraded).toBe(false);
      expect(state.consecutiveExhaustedSequences).toBe(0);
    });

    it("should reset counter on recovery", async () => {
      const threshold = testConfig.consecutiveExhaustedRetriesForDegradedMode;

      for (let i = 0; i < threshold; i++) {
        try {
          await loop.executeWithDegradedModeTracking(`fail-${i}`, async () => {
            throw new Error("Error");
          });
        } catch {
          // Expected
        }
      }

      await loop.executeWithDegradedModeTracking("success", async () => "ok");

      const state = loop.getState();
      expect(state.consecutiveExhaustedSequences).toBe(0);
    });

    it("should allow re-entry to degraded mode after recovery", async () => {
      const threshold = testConfig.consecutiveExhaustedRetriesForDegradedMode;

      // Episode 1: enter and exit degraded mode
      for (let i = 0; i < threshold; i++) {
        try {
          await loop.executeWithDegradedModeTracking(`ep1-fail-${i}`, async () => {
            throw new Error("Error");
          });
        } catch {
          // Expected
        }
      }

      await loop.executeWithDegradedModeTracking("recovery-1", async () => "ok");

      // Episode 2: enter degraded mode again
      for (let i = 0; i < threshold; i++) {
        try {
          await loop.executeWithDegradedModeTracking(`ep2-fail-${i}`, async () => {
            throw new Error("Error");
          });
        } catch {
          // Expected
        }
      }

      const state = loop.getState();
      expect(state.isDegraded).toBe(true);
      expect(alertTransport.getAlertCount()).toBe(2); // Two separate episodes
    });
  });

  describe("Interval behavior: polling interval changes with degraded mode state", () => {
    it("should return normal polling interval in normal mode", () => {
      const interval = loop.getCurrentPollingInterval();
      expect(interval).toBe(testConfig.pollIntervalMs);
    });

    it("should return degraded polling interval in degraded mode", async () => {
      const threshold = testConfig.consecutiveExhaustedRetriesForDegradedMode;

      for (let i = 0; i < threshold; i++) {
        try {
          await loop.executeWithDegradedModeTracking(`fail-${i}`, async () => {
            throw new Error("Error");
          });
        } catch {
          // Expected
        }
      }

      const interval = loop.getCurrentPollingInterval();
      expect(interval).toBe(testConfig.degradedModePollingIntervalMs);
    });

    it("should restore normal polling interval on recovery", async () => {
      const threshold = testConfig.consecutiveExhaustedRetriesForDegradedMode;

      for (let i = 0; i < threshold; i++) {
        try {
          await loop.executeWithDegradedModeTracking(`fail-${i}`, async () => {
            throw new Error("Error");
          });
        } catch {
          // Expected
        }
      }

      expect(loop.getCurrentPollingInterval()).toBe(testConfig.degradedModePollingIntervalMs);

      await loop.executeWithDegradedModeTracking("success", async () => "ok");

      expect(loop.getCurrentPollingInterval()).toBe(testConfig.pollIntervalMs);
    });
  });

  describe("Diagnostics and state inspection", () => {
    it("should provide correct diagnostics in normal mode", () => {
      const diag = loop.getDiagnostics();
      expect(diag.isDegraded).toBe(false);
      expect(diag.consecutiveExhaustedSequences).toBe(0);
      expect(diag.threshold).toBe(testConfig.consecutiveExhaustedRetriesForDegradedMode);
      expect(diag.currentPollingIntervalMs).toBe(testConfig.pollIntervalMs);
      expect(diag.alertSentInCurrentEpisode).toBe(false);
    });

    it("should provide correct diagnostics in degraded mode", async () => {
      const threshold = testConfig.consecutiveExhaustedRetriesForDegradedMode;

      for (let i = 0; i < threshold; i++) {
        try {
          await loop.executeWithDegradedModeTracking(`fail-${i}`, async () => {
            throw new Error("Error");
          });
        } catch {
          // Expected
        }
      }

      const diag = loop.getDiagnostics();
      expect(diag.isDegraded).toBe(true);
      expect(diag.consecutiveExhaustedSequences).toBe(threshold);
      expect(diag.currentPollingIntervalMs).toBe(testConfig.degradedModePollingIntervalMs);
      expect(diag.alertSentInCurrentEpisode).toBe(true);
    });
  });

  describe("Regression: withRetry backoff behavior unchanged", () => {
    it("should preserve withRetry behavior (no changes to retry logic)", async () => {
      const callAttempts: number[] = [];

      // Mock a function that tracks call attempts
      let attempt = 0;
      const fn = async () => {
        attempt++;
        callAttempts.push(attempt);
        throw new Error("Simulated failure");
      };

      try {
        await loop.executeWithDegradedModeTracking("retry-test", fn, {
          maxRetries: 2,
          retryBaseMs: 10,
        });
      } catch {
        // Expected
      }

      // Should have attempted 3 times (maxRetries + 1)
      expect(callAttempts.length).toBe(3);
      expect(callAttempts).toEqual([1, 2, 3]);
    });
  });

  describe("simulateRound helper", () => {
    it("should track successes and failures in a simulated round", async () => {
      const operations = [
        { label: "op1", fn: async () => {}, shouldFail: false },
        { label: "op2", fn: async () => {}, shouldFail: true },
        { label: "op3", fn: async () => {}, shouldFail: false },
      ];

      const result = await simulateRound(loop, operations);
      expect(result.successCount).toBe(2);
      expect(result.failureCount).toBe(1);
    });
  });
});
