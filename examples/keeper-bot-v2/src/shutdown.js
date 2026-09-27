"use strict";

/**
 * Graceful Shutdown Coordinator for Keeper Bot v2 (Issue #402).
 *
 * Preserves v1's graceful shutdown guarantee under concurrency:
 * - Stops new work from starting once a shutdown signal is received.
 * - Tracks all active concurrent workers in flight (claims, executions, submissions).
 * - Waits for every in-flight worker to finish its current submission and persist outcomes.
 * - Enforces a bounded maximum drain time so a stalled worker or network hang cannot block shutdown indefinitely.
 */

class ShutdownCoordinator {
  /**
   * @param {Object} [options]
   * @param {number} [options.maxDrainMs=10000] - Maximum milliseconds to wait for workers to drain before forcing exit.
   * @param {Object} [options.logger=console] - Logger interface.
   */
  constructor(options = {}) {
    this.maxDrainMs = options.maxDrainMs ?? 10000;
    this.logger = options.logger ?? console;
    this.isShuttingDown = false;
    this.shutdownReason = null;
    this.activeWorkers = new Set();
    this.drainPromise = null;
    this._signalHandlers = [];
  }

  /**
   * Registers OS signal listeners (SIGINT, SIGTERM) to trigger graceful shutdown.
   * @param {string[]} [signals=["SIGINT", "SIGTERM"]]
   */
  registerSignals(signals = ["SIGINT", "SIGTERM"]) {
    for (const signal of signals) {
      const handler = () => {
        this.initiateShutdown(signal).catch((err) => {
          this.logger.error(`Error during graceful shutdown on ${signal}:`, err);
        });
      };
      process.on(signal, handler);
      this._signalHandlers.push({ signal, handler });
    }
  }

  /**
   * Unregisters any attached OS signal listeners (useful for tests or teardown).
   */
  unregisterSignals() {
    for (const { signal, handler } of this._signalHandlers) {
      process.removeListener(signal, handler);
    }
    this._signalHandlers = [];
  }

  /**
   * Track an active worker Promise.
   * @template T
   * @param {Promise<T>} workerPromise
   * @returns {Promise<T>}
   */
  track(workerPromise) {
    if (this.isShuttingDown) {
      throw new Error(`Cannot start new work: shutdown already initiated (${this.shutdownReason})`);
    }

    this.activeWorkers.add(workerPromise);
    const cleanup = () => {
      this.activeWorkers.delete(workerPromise);
    };
    workerPromise.then(cleanup, cleanup);
    return workerPromise;
  }

  /**
   * Run an asynchronous worker function wrapped under tracking.
   * Returns null if shutdown has already been requested.
   * @template T
   * @param {() => Promise<T>} fn
   * @returns {Promise<T|null>}
   */
  async runWorker(fn) {
    if (this.isShuttingDown) {
      return null;
    }

    let resolveWorker, rejectWorker;
    const workerPromise = new Promise((resolve, reject) => {
      resolveWorker = resolve;
      rejectWorker = reject;
    });

    this.track(workerPromise);

    try {
      const result = await fn();
      resolveWorker(result);
      return result;
    } catch (err) {
      rejectWorker(err);
      throw err;
    }
  }

  /**
   * Returns whether a shutdown has been triggered.
   * @returns {boolean}
   */
  shouldStop() {
    return this.isShuttingDown;
  }

  /**
   * Returns count of currently active in-flight workers.
   * @returns {number}
   */
  getActiveCount() {
    return this.activeWorkers.size;
  }

  /**
   * Initiate graceful shutdown, waiting for all in-flight workers up to maxDrainMs.
   * @param {string} [reason="MANUAL"]
   * @returns {Promise<{ drainedCount: number, timedOut: boolean, remaining: number }>}
   */
  async initiateShutdown(reason = "MANUAL") {
    if (this.drainPromise) {
      return this.drainPromise;
    }

    this.isShuttingDown = true;
    this.shutdownReason = reason;
    this.logger.log(`Shutdown initiated (${reason}). Waiting for ${this.activeWorkers.size} in-flight workers to drain (max wait: ${this.maxDrainMs}ms)...`);

    this.drainPromise = this._drain();
    return this.drainPromise;
  }

  /**
   * Internal drain implementation with race between completion and timeout.
   * @private
   */
  async _drain() {
    const initialCount = this.activeWorkers.size;
    if (initialCount === 0) {
      this.logger.log("No in-flight workers. Shutdown complete.");
      return { drainedCount: 0, timedOut: false, remaining: 0 };
    }

    let timerId;
    const timeoutPromise = new Promise((resolve) => {
      timerId = setTimeout(() => {
        resolve({ timedOut: true });
      }, this.maxDrainMs);
    });

    const completionPromise = Promise.allSettled(Array.from(this.activeWorkers)).then(() => ({
      timedOut: false,
    }));

    const result = await Promise.race([completionPromise, timeoutPromise]);
    clearTimeout(timerId);

    const remaining = this.activeWorkers.size;
    const drainedCount = initialCount - remaining;

    if (result.timedOut) {
      this.logger.warn(
        `Shutdown drain timed out after ${this.maxDrainMs}ms. ${remaining} worker(s) still in flight.`
      );
      return { drainedCount, timedOut: true, remaining };
    }

    this.logger.log(`All ${initialCount} in-flight workers drained successfully. Clean shutdown.`);
    return { drainedCount: initialCount, timedOut: false, remaining: 0 };
  }
}

module.exports = {
  ShutdownCoordinator,
};
