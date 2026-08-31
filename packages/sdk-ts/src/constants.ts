/**
 * The SDK's copy of the contract constants it enforces client-side.
 *
 * Every value here mirrors `contracts/keeper-registry/src/constants.rs`'s Rust
 * original and is only ever a fast local pre-check: the deployed contract
 * remains authoritative. A copy that has drifted low rejects calls the chain
 * would have accepted; a copy that has drifted high just costs a round trip.
 * Neither can make an invalid call succeed.
 *
 * Keeping them in sync is tied to the contract's `VERSION`: when the contract
 * bumps `VERSION`, these constants and {@link SUPPORTED_CONTRACT_VERSIONS} are
 * reviewed in the same SDK release. See the versioning policy (backlog issue
 * 0192) for the release-mapping rules.
 */

/**
 * Contract `VERSION` values this SDK release was built against, inclusive.
 *
 * `min` is the oldest deployment whose ABI this SDK still speaks; `max` is the
 * newest it has been tested against. A deployment reporting a version outside
 * this range is not refused -- see `client.version()`, which warns rather than
 * throwing, because a newer contract is usually additive and an SDK that
 * hard-fails on it strands every integrator until they can upgrade.
 */
export const SUPPORTED_CONTRACT_VERSIONS = {
  min: 1,
  max: 3,
} as const;
/** Maximum `proof` length in bytes accepted by `execute_task`. */
export const MAX_PROOF_LEN = 256;
