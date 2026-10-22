import { SUPPORTED_CONTRACT_VERSIONS } from "@soroban-keeper-network/sdk";

/** Kept in step with package.json by hand; a test fails if they drift. */
export const CLI_VERSION = "0.1.0";

/** What `skn --version` prints: the CLI's version and the contract versions it speaks. */
export function versionText(): string {
  const { min, max } = SUPPORTED_CONTRACT_VERSIONS;
  return `skn ${CLI_VERSION} (supports keeper-registry contract versions ${min}-${max})`;
}
