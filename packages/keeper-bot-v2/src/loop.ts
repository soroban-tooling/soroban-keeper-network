/**
 * Main keeper loop with graceful degradation during RPC outages.
 *
 * This module implements the core loop logic and tracks consecutive fully-exhausted
 * retry sequences to enter degraded mode when an extended RPC outage is detected.
 */

import { withRetry } from "@soroban-keeper-network/sdk";
import type { Config, DegradedModeState, AlertTransport, Alert } from "./types.js";

/**
 * KeeperLoop manages the main polling loop with degraded mode support.
 */
export class KeeperLoop {
  private config: Config;
  private alertTransport: AlertTransport;
  private state: DegradedModeState;

  constructor(config: Config, alertTransport: AlertTransport) {
    this.config = config;
    this.alertTransport = alertTransport;
    this.state = {
      isDegraded: false,
      consecutiveExhaustedSequences: 0,
      alertSentInCurrentEpisode: false,
    };
  }

  /**
   * Get current degraded mode state (for testing and diagnostics).
   */
  getState(): Readonly<DegradedModeState> {
    return { ...this.state };
  }

  /**
   * Wraps an async operation with degraded mode tracking.
   *
   * On success (no error from withRetry):
   *   - If in degraded mode, exit it and reset counter
   *   - Otherwise, just reset the counter
   *
   * On failure (withRetry exhausted all attempts):
   *   - Increment consecutive exhausted sequences counter
   *   - If threshold reached, enter degraded mode and send alert
   *   - Re-throw the error to let caller handle it
   */
  async executeWithDegradedModeTracking<T>(
    label: string,
    fn: () => Promise<T>,
    retryOptions?: { maxRetries?: number; retryBaseMs?: number }
  ): Promise<T> {
    try {
      const result = await withRetry(fn, {
        maxRetries: retryOptions?.maxRetries ?? this.config.maxRetries,
        retryBaseMs: retryOptions?.retryBaseMs ?? this.config.retryBaseMs,
      });

      // Success: reset counter and exit degraded mode if we were in it
      if (this.state.isDegraded) {
        console.log("✅ RPC call succeeded; exiting degraded mode");
        this.state.isDegraded = false;
        this.state.consecutiveExhaustedSequences = 0;
        this.state.alertSentInCurrentEpisode = false;
      } else {
        this.state.consecutiveExhaustedSequences = 0;
      }

      return result;
    } catch (error) {
      // Exhausted sequence: increment counter
      this.state.consecutiveExhaustedSequences++;
      console.warn(
        `${label} exhausted all retries. Consecutive exhausted sequences: ${this.state.consecutiveExhaustedSequences}/${this.config.consecutiveExhaustedRetriesForDegradedMode}`
      );

      // Check if we should enter degraded mode
      if (
        !this.state.isDegraded &&
        this.state.consecutiveExhaustedSequences >= this.config.consecutiveExhaustedRetriesForDegradedMode
      ) {
        this.state.isDegraded = true;
        console.error("🚨 Entering degraded mode due to repeated RPC failures");

        // Fire alert exactly once per episode
        if (!this.state.alertSentInCurrentEpisode) {
          try {
            const alert: Alert = {
              type: "degraded-mode-entry",
              severity: "critical",
              message: `Keeper entered degraded mode after ${this.state.consecutiveExhaustedSequences} consecutive fully-exhausted retry sequences. Polling interval increased from ${this.config.pollIntervalMs}ms to ${this.config.degradedModePollingIntervalMs}ms.`,
              timestamp: Date.now(),
            };
            await this.alertTransport.raise(alert);
            this.state.alertSentInCurrentEpisode = true;
          } catch (alertError) {
            // Alert failure should not crash the loop
            console.error("Failed to send degraded mode alert:", alertError);
          }
        }
      }

      throw error;
    }
  }

  /**
   * Get the current polling interval based on degraded mode state.
   */
  getCurrentPollingInterval(): number {
    return this.state.isDegraded
      ? this.config.degradedModePollingIntervalMs
      : this.config.pollIntervalMs;
  }

  /**
   * Get diagnostic info about current loop state.
   */
  getDiagnostics(): {
    isDegraded: boolean;
    consecutiveExhaustedSequences: number;
    threshold: number;
    currentPollingIntervalMs: number;
    alertSentInCurrentEpisode: boolean;
  } {
    return {
      isDegraded: this.state.isDegraded,
      consecutiveExhaustedSequences: this.state.consecutiveExhaustedSequences,
      threshold: this.config.consecutiveExhaustedRetriesForDegradedMode,
      currentPollingIntervalMs: this.getCurrentPollingInterval(),
      alertSentInCurrentEpisode: this.state.alertSentInCurrentEpisode,
    };
  }
}

/**
 * Simulates a keeper loop round for testing degraded mode behavior.
 * This is a minimal implementation to test the state machine logic.
 */
export async function simulateRound(
  loop: KeeperLoop,
  operations: Array<{ label: string; fn: () => Promise<void>; shouldFail?: boolean }>
): Promise<{ successCount: number; failureCount: number }> {
  let successCount = 0;
  let failureCount = 0;

  for (const op of operations) {
    try {
      const actualFn = op.shouldFail
        ? async () => {
            throw new Error(`Simulated RPC error: ${op.label}`);
          }
        : op.fn;

      await loop.executeWithDegradedModeTracking(op.label, actualFn);
      successCount++;
    } catch (error) {
      failureCount++;
      console.log(`Round: ${op.label} failed (expected for test)`);
    }
  }

  return { successCount, failureCount };
}
