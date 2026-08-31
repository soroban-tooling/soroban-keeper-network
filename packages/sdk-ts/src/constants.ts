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

/** Maximum `proof` length in bytes accepted by `execute_task`. */
export const MAX_PROOF_LEN = 256;
