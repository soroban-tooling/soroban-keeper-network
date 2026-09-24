/**
 * Test suite for alert transports.
 */

import { describe, it, expect } from "vitest";
import { LoggingAlert, NoOpAlert } from "./alerts.js";
import type { Alert } from "./types.js";

describe("Alert Transports", () => {
  const testAlert: Alert = {
    type: "degraded-mode-entry",
    severity: "critical",
    message: "Test alert",
    timestamp: Date.now(),
  };

  describe("LoggingAlert", () => {
    it("should accept and log alerts without throwing", async () => {
      const alerter = new LoggingAlert();
      await expect(alerter.raise(testAlert)).resolves.not.toThrow();
    });
  });

  describe("NoOpAlert", () => {
    it("should accept alerts and do nothing", async () => {
      const alerter = new NoOpAlert();
      await expect(alerter.raise(testAlert)).resolves.not.toThrow();
    });
  });
});
