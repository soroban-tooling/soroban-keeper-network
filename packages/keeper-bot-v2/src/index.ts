/**
 * Keeper Bot v2 - production-ready keeper for Soroban Keeper Network
 *
 * Main entry point. Exports the KeeperLoop class and related types.
 */

export { KeeperLoop, simulateRound } from "./loop.js";
export { loadConfig } from "./config.js";
export { LoggingAlert, NoOpAlert, getAlertTransport } from "./alerts.js";
export type { Config, Alert, AlertTransport, DegradedModeState } from "./types.js";
