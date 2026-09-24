/**
 * Keeper Bot v2 - production-ready keeper for Soroban Keeper Network
 *
 * Main entry point. Exports secrets module for key management and KeeperLoop for core operations.
 */

// Secrets management exports
export * from "./secrets/index.js";

// Keeper loop and core functionality
export { KeeperLoop, simulateRound } from "./loop.js";
export { loadConfig } from "./config.js";
export { LoggingAlert, NoOpAlert, getAlertTransport } from "./alerts.js";
export type { Config, Alert, AlertTransport, DegradedModeState } from "./types.js";
