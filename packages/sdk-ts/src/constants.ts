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

// ── Task parameter bounds, mirrored from `constants.rs` ──────────────────────
//
// `register_task` validates each of these on-chain (`validate_task_params` in
// `internal.rs`). They are named here so the client-side pre-check in
// `methods/registerTask.ts` and any future caller share one copy, per the same
// rule the contract follows: a value enforced in more than one place gets a
// name in exactly one place.

/** Maximum `calldata` length in bytes accepted by `register_task`. */
export const MAX_CALLDATA_LEN = 1024;

/** Smallest `lock_ledgers` a task may be registered with (~1 minute). */
export const MIN_LOCK_LEDGERS = 12;

/** Largest `lock_ledgers` a task may be registered with (~1 day). */
export const MAX_LOCK_LEDGERS = 17_280;

/** Smallest `ttl_ledgers` a task may be registered with (~83 minutes). */
export const MIN_TTL_LEDGERS = 1_000;
