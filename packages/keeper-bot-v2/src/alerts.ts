/**
 * Alerting infrastructure for keeper-bot-v2.
 * Provides a pluggable transport interface and default logging implementation.
 * 
 * This is a stub implementation to support degraded mode alerting.
 * Full alerting implementation (for missed executions, balance stagnation, etc.)
 * will be completed in issue #0258.
 */

import type { Alert, AlertTransport } from "./types.js";

/**
 * Default logging alert transport - always enabled as fallback.
 */
export class LoggingAlert implements AlertTransport {
  async raise(alert: Alert): Promise<void> {
    const prefix = alert.severity === "critical" ? "❌ CRITICAL" : "⚠️ WARNING";
    console.log(
      `${prefix} [${alert.type}] ${alert.message}`,
      alert.taskId ? `(task: ${alert.taskId})` : ""
    );
  }
}

/**
 * NoOp alert transport for testing or when alerting is disabled.
 */
export class NoOpAlert implements AlertTransport {
  async raise(_alert: Alert): Promise<void> {
    // Do nothing
  }
}

/**
 * Gets the configured alert transport.
 * For now, returns the logging transport by default.
 * Future: could load transport from config (webhook URL, PagerDuty API key, etc.)
 */
export function getAlertTransport(): AlertTransport {
  return new LoggingAlert();
}
