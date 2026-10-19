import { SDK_VERSION, SUPPORTED_CONTRACT_VERSIONS } from "@soroban-keeper-network/sdk";

/** Mirrors package.json's `version`; test/cli.test.ts fails if they drift. */
export const CLI_VERSION = "0.1.0";

/** What `skn --version` prints. */
export function versionText(): string {
  // Widened from the SDK's `as const` literals so the single-version case
  // still typechecks once min and max are equal.
  const min: number = SUPPORTED_CONTRACT_VERSIONS.min;
  const max: number = SUPPORTED_CONTRACT_VERSIONS.max;
  const range = min === max ? `${min}` : `${min}-${max}`;
  return [
    `skn ${CLI_VERSION}`,
    `@soroban-keeper-network/sdk ${SDK_VERSION}`,
    `keeper-registry contract versions: ${range}`,
  ].join("\n");
}
