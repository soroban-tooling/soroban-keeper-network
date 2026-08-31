// Entry point for @soroban-keeper-network/sdk.
//
// This package is a scaffold (backlog 0151 / epic E12): build tooling,
// TypeScript config, and a placeholder export, proving the ESM/CJS/.d.ts
// build pipeline works end to end. The typed KeeperRegistryClient and its
// per-entry-point methods are filled in by the rest of epic E12's issues.

/** The SDK's own package version, kept in sync with package.json by hand until a release job automates it (see backlog 0186). */
export const SDK_VERSION = "0.1.0";
export { KeeperRegistryClient } from "./client.js";
export type { KeeperRegistryClientOptions } from "./client.js";
export {
  NETWORK_PRESETS,
  NETWORK_NAMES,
  isNetworkName,
} from "./network.js";
export type { NetworkName, NetworkPreset } from "./network.js";
export { withRetry } from "./retry.js";
export type { RetryOptions } from "./retry.js";
export {
  KeeperErrorCode,
  decodeKeeperError,
  isKeeperError,
} from "./errors.js";
export type { DecodedKeeperError } from "./errors.js";
export {
  SDK_VERSION,
  COMPATIBLE_CONTRACT_VERSIONS,
  checkContractCompatibility,
  compatibilityWarning,
} from "./version.js";
export type { CompatibilityResult } from "./version.js";
