/**
 * SDK ↔ contract version compatibility (issue 0261 in the SDK epic —
 * `packages/sdk-ts/VERSIONING.md` documents the policy this table
 * implements).
 *
 * Kept as code rather than only prose so the runtime check in
 * `checkContractCompatibility` below has something precise to check against
 * — a policy that only lives in a markdown file cannot be enforced.
 */

/** This package's own version. Mirrors `package.json`'s `version` field — kept in sync by hand (see VERSIONING.md's release checklist) since importing package.json's contents into ESM output has its own build-tooling cost this scaffold doesn't take on yet. */
export const SDK_VERSION = "0.1.0";

/**
 * Contract `VERSION` values (see `contracts/keeper-registry/src/constants.rs`)
 * this SDK release is known to work against.
 *
 * SDK 0.1.0 targets contract VERSION 3, the value in `constants.rs` as of
 * this SDK's initial release. See VERSIONING.md for how this list grows
 * across future SDK releases.
 */
export const COMPATIBLE_CONTRACT_VERSIONS: readonly number[] = [3];

export interface CompatibilityResult {
  readonly compatible: boolean;
  readonly contractVersion: number | undefined;
  readonly sdkVersion: string;
  readonly compatibleContractVersions: readonly number[];
}

/**
 * Compares a deployed contract's `VERSION` (from
 * `KeeperRegistryClient.version()`) against this SDK release's declared
 * compatible range.
 *
 * `contractVersion: undefined` (the contract's version() call failed, or an
 * older deployment has no version() function at all) is reported as
 * incompatible — an SDK cannot claim compatibility with a contract whose
 * version it could not determine.
 */
export function checkContractCompatibility(
  contractVersion: number | undefined,
): CompatibilityResult {
  return {
    compatible:
      contractVersion !== undefined &&
      COMPATIBLE_CONTRACT_VERSIONS.includes(contractVersion),
    contractVersion,
    sdkVersion: SDK_VERSION,
    compatibleContractVersions: COMPATIBLE_CONTRACT_VERSIONS,
  };
}

/**
 * Human-readable warning for a version mismatch, or `undefined` when
 * compatible. Callers log this (or surface it however fits their
 * application) rather than the SDK deciding how warnings are delivered.
 */
export function compatibilityWarning(
  result: CompatibilityResult,
): string | undefined {
  if (result.compatible) return undefined;

  const range = result.compatibleContractVersions.join(", ");
  if (result.contractVersion === undefined) {
    return (
      `@soroban-keeper-network/sdk@${result.sdkVersion} could not determine the ` +
      `deployed contract's VERSION. This SDK release is known to work with contract ` +
      `VERSION [${range}]; proceed with caution.`
    );
  }
  return (
    `@soroban-keeper-network/sdk@${result.sdkVersion} declares compatibility with ` +
    `contract VERSION [${range}], but the deployed contract reports VERSION ` +
    `${result.contractVersion}. Behavior is not guaranteed outside the declared range ` +
    `— see packages/sdk-ts/VERSIONING.md.`
  );
}
