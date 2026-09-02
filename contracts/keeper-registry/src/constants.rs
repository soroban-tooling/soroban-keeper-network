//! Tunable bounds and protocol constants.
//!
//! Every magic number the contract enforces lives here so a change is a
//! one-line edit rather than a hunt through the call sites.

// ─────────────────────────────────────────────────────────────────────────────
// Task parameter bounds
// ─────────────────────────────────────────────────────────────────────────────

/// Stellar closes a ledger roughly every 5 seconds. A lock window shorter than
/// this gives the claiming keeper no realistic chance to build and submit its
/// `execute_task` transaction before another keeper can reclaim the task out
/// from under it.
pub(crate) const MIN_LOCK_LEDGERS: u32 = 12; // ~1 minute

/// A lock window longer than this lets a single unresponsive keeper hold a
/// task hostage for the better part of a day, with no possibility of
/// takeover until `expire_task` becomes callable at the deadline.
pub(crate) const MAX_LOCK_LEDGERS: u32 = 17_280; // ~1 day

/// Persistent storage entries need enough runway to survive from
/// registration through claim and execution without lapsing mid-flight.
/// Below this, the TTL extension is not worth writing and risks the entry
/// (and its escrowed reward) becoming inaccessible before a keeper can act.
pub(crate) const MIN_TTL_LEDGERS: u32 = 1_000; // ~83 minutes

// ─────────────────────────────────────────────────────────────────────────────
// TTL constants
// ─────────────────────────────────────────────────────────────────────────────
//
// Soroban archives storage entries once their TTL reaches zero; an archived
// entry must be explicitly restored before it can be read or written again.
// Instance storage holds the admin, reward token, pause flag, fee, and task
// counter — every entry point reads it, so it must never be allowed to lapse
// on an actively-used contract.

/// Ledgers of instance-storage lifetime requested on each state-mutating
/// call. At ~5s per ledger this is roughly 6 days; renewing it on every
/// mutation means a contract that sees regular traffic never approaches
/// archival.
pub(crate) const INSTANCE_BUMP_LEDGERS: u32 = 100_000;
/// Renew instance TTL only once fewer than this many ledgers remain, so the
/// extension is a no-op on most calls and only costs resources when the
/// entry is genuinely approaching expiry.
pub(crate) const INSTANCE_BUMP_THRESHOLD: u32 = 50_000;

/// Ledgers of persistent-storage lifetime requested for a keeper's reward
/// balance entry each time it is credited. Mirrors [`INSTANCE_BUMP_LEDGERS`].
pub(crate) const KEEPER_BALANCE_BUMP_LEDGERS: u32 = 100_000;
/// Renew a keeper balance entry only once fewer than this many ledgers
/// remain. Mirrors [`INSTANCE_BUMP_THRESHOLD`].
pub(crate) const KEEPER_BALANCE_BUMP_THRESHOLD: u32 = 50_000;

// ─────────────────────────────────────────────────────────────────────────────
// Contract
// ─────────────────────────────────────────────────────────────────────────────

/// Semantic version of the contract logic. Bumped on behavior changes so
/// off-chain clients and indexers can detect which ABI they are talking to.
///
/// - `1` — MVP lifecycle surface.
/// - `2` — `calldata` bounded by [`MAX_CALLDATA_LEN`], adding the
///   `CalldataTooLarge` error variant.
/// - `3` — batch registration: the `batch_register_tasks` and
///   `max_batch_size` entry points, the [`BatchTaskParams`] type, and the
///   `BatchTooLarge` / `EmptyBatch` / `BatchRewardCeilingExceeded` error
///   variants.
/// - `4` — optional on-chain proof verifier: `register_task`'s new
///   `verifier: Option<Address>` parameter, the `IKeeperVerifier` interface
///   `execute_task` calls before crediting the keeper, and the
///   `VerificationFailed` error / `TaskVerificationFailed` event. See
///   `docs/VERIFIER_DESIGN.md`.
pub const VERSION: u32 = 4;

/// Maximum `calldata` length, in bytes. Sized to hold an encoded contract
/// call — a target address, a function symbol, and a handful of scalar or
/// address arguments (an XDR-encoded `Address` is ~40 bytes, a `Symbol` up to
/// 32) — with headroom, without letting a task owner push storage and
/// re-serialisation cost onto the keepers and passers-by who load and
/// re-write this `Task` on every later lifecycle call (`claim_task`,
/// `execute_task`, and the permissionless `expire_task`).
pub const MAX_CALLDATA_LEN: u32 = 1024;

/// Maximum length, in bytes, of the `proof` accepted by `execute_task`.
/// Event data is charged against the paying keeper's transaction resource
/// budget, so an unbounded proof would make execution arbitrarily expensive.
/// 256 bytes comfortably fits a 32-byte tx hash or a small state witness —
/// the two shapes of proof this MVP expects — while keeping the emitted
/// event's cost bounded and predictable.
pub const MAX_PROOF_LEN: u32 = 256;

/// Maximum number of task ids a single [`KeeperRegistry::get_tasks`] or
/// [`KeeperRegistry::get_tasks_range`] call will accept.
///
/// Each id costs exactly one Persistent storage read, and every read is
/// charged against the transaction's read-entry and read-bytes resource
/// limits. A `Task` is dominated by its `calldata`, capped at
/// [`MAX_CALLDATA_LEN`] (1 KiB), so a worst-case batch of 50 reads moves on the
/// order of 50 KiB plus 50 ledger entries — comfortably inside a single
/// simulation on both counts, with room for the rest of a caller's footprint.
///
/// This is a deliberately conservative bound rather than the largest that
/// would fit: a batch read that intermittently exceeds the resource budget is
/// worse for a polling bot than one that is always cheap, because the failure
/// depends on the *contents* of the range rather than on anything the caller
/// controls. Callers needing more than 50 tasks issue several calls.
pub const MAX_BATCH_READ: u32 = 50;
/// Maximum number of entries accepted by
/// [`KeeperRegistry::batch_register_tasks`].
///
/// **This is a conservative bound, not yet an empirically measured one** —
/// measuring the real ceiling against Soroban's per-transaction CPU and
/// ledger-write budgets is backlog issue 0104's job, and this constant should
/// be revised (up or down) once that measurement lands. It exists now so an
/// oversized batch fails with [`KeeperError::BatchTooLarge`] rather than an
/// opaque host-level resource-exhaustion error the caller cannot act on.
///
/// Why 50: each entry writes one `Task`, whose `calldata` alone may be up to
/// [`MAX_CALLDATA_LEN`] (1024) bytes. At 50 entries that is ~50 KB of ledger
/// writes in a single transaction before the rest of the `Task` struct, the
/// per-entry token transfer, and the per-entry event are counted. Entry count
/// is therefore only half the story: a batch of small-`calldata` entries has
/// far more headroom than a batch of maximum-sized ones, and a caller who
/// packs both large payloads and many entries can still exhaust the budget
/// below this cap. See `docs/BATCH_OPERATIONS.md` §4.
pub const MAX_BATCH_SIZE: u32 = 50;

/// Ledgers close roughly every 5 seconds on Stellar. Used only to sanity-check
/// that a task's storage outlives its deadline; a conservative estimate is
/// correct here because over-estimating the ledger rate over-provisions TTL.
pub(crate) const SECONDS_PER_LEDGER: u64 = 5;

/// Extra ledgers kept beyond the deadline so `expire_task` (and `cancel_task`/
/// `execute_task`) are still callable for a while after the deadline passes,
/// giving a margin against clock drift between the two units below.
pub(crate) const TTL_SAFETY_MARGIN_LEDGERS: u32 = 17_280; // ~1 day

/// Protocol fee applied when `FeeBps` has never been written. Kept at zero so
/// an uninitialized or partially-migrated registry can never silently skim
/// from a keeper's reward: a fee is a transfer of value away from the keeper,
/// and defaulting to charging one on a contract whose configuration is
/// unknown is the more surprising of the two failure modes.
pub const DEFAULT_FEE_BPS: u32 = 0;
