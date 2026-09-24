# Staking and Slashing Architecture (Epic E06)

This document answers the questions backlog issue 0288 opened, so issues 0289 onward (this
implementation covers a scoped subset — see "Scope of this implementation" below) build against a
fixed design rather than each guessing independently, the failure mode epic E04's verifier work
suffered from before `docs/VERIFIER_DESIGN.md` was written.

## Correction to 0288's own premise

0288's text states the E04 verifier "was designed... but never actually implemented" and that
`Task` "has no verifier field today." **This is stale.** `Task.verifier: Option<Address>` exists
(`types.rs:104`), `execute_task` calls it before crediting a keeper (`task.rs`, gated on
`task.verifier.clone()`), and `KeeperError::VerificationFailed` / the `TaskVerificationFailed`
event are both live (`errors.rs:62`, `events.rs:134`). Automatic slashing tied to a verifier
rejection is therefore **not** blocked the way 0288 assumed — it is a real, buildable option, just
not the one this document chooses for v1 (see below).

## 1. What counts as slashable, and the trigger model

**Decision: v1 is admin-triggered, not automatic and not dispute-based.**

`slash(admin, keeper, amount, reason, incident_id)` is callable only by the contract admin
(`require_admin`, the same helper every other admin-only entry point already uses). No on-chain
condition automatically produces a slash; the admin decides off-chain (a fraudulent proof reported
by a verifier operator, a pattern the protocol flags, a governance decision) and submits the call.

**Why not automatic-on-verifier-rejection:** a rejected proof (`VerificationFailed`) already has a
consequence — the keeper is not paid, and `execute_task` leaves the task `Claimed` for another
keeper to retry. Automatically slashing on every rejection would punish honest failures (a keeper
whose off-chain infrastructure had a transient bug) exactly as harshly as fraud, with no way to
tell the two apart on-chain. Tying slashing to verifier rejection is a reasonable v2 direction once
there's a track record of what rejection reasons actually correlate with malice versus noise, but
is deliberately deferred.

**Why not dispute-based:** a dispute window needs a challenge mechanism (who can raise one, an
escrow-during-dispute state, a resolution process) that is a substantial feature on its own and
is not needed to satisfy this epic's four in-scope issues. Deferred to a later E06 follow-up
issue, explicitly out of scope here.

**Trade-off accepted:** v1 slashing is only as trustworthy as the admin key. This mirrors every
other admin-gated action already in this contract (`pause`, `sweep_fees`, `set_fee_bps`) — the
admin is already a trusted, privileged role, so this does not introduce a new trust assumption,
only extends the existing one to a new action.

## 2. Where stake lives

**Decision: in this contract, under its own storage key (`DataKey::KeeperStake`), not a separate
staking contract.**

Mirrors the existing separation-of-concerns precedent that already keeps `FeesAccrued` distinct
from task escrow and `KeeperReward` (types.rs:19-25): a new key, never conflated with the reward
balance, so a bug in one accounting path can never accidentally touch the other. A dedicated
staking contract would isolate stake-related bugs further, at the cost of a cross-contract call on
every stake-checked operation (this epic's four issues do not require any stake-gated behavior on
`claim_task`/`execute_task` — see §5 — so that cost has no offsetting benefit yet). Revisit if a
future issue makes stake-gating a hot path.

## 3. Unbonding

**Decision: a fixed-ledger delay, required for every withdrawal.**

`initiate_unbond(keeper, amount)` starts the delay; `withdraw_stake(keeper)` only releases funds
whose delay has elapsed, mirroring the `claim_ledger` + `lock_ledgers` pattern task claiming
already uses (`internal::lock_expired`). Delay length: `UNBOND_DELAY_LEDGERS = 17_280` (~1 day),
matching `TTL_SAFETY_MARGIN_LEDGERS`'s existing precedent for "give admin/operators about a day to
react" — this is a scoped decision for the primitive itself, not a claim that a dispute window
exists yet (none does, per §1); the delay exists so a keeper cannot deposit, misbehave, and
instantly withdraw before an admin notices and calls `slash`, which needs the stake to still be
present.

## 4. Dispute window

**N/A for v1.** Slashing is admin-triggered (§1), not dispute-based, so there is no challenge
period, no "who can dispute," and no pending-dispute state. This section exists only to record
that the question was considered and explicitly deferred, not skipped.

## 5. Interaction with existing mechanics

**Decision: none in this implementation.** A staked keeper receives no different treatment in
`claim_task` or `execute_task` — no priority, no altered lock window. Backlog issue 0292 (deciding
whether `claim_task` should require a minimum stake) is explicitly **not** part of this
implementation's scope; see below.

## 6. Incident-level idempotency (slash-specific, beyond 0288's original questions)

`slash` takes a caller-supplied `incident_id: BytesN<32>`. A `DataKey::SlashIncident(BytesN<32>)`
seen-set records every incident already slashed; a repeat call with the same `incident_id` is
rejected with `KeeperError::DuplicateSlashIncident` rather than slashing the keeper twice for the
same underlying event. The admin is responsible for choosing a stable incident identifier
off-chain (e.g. a hash of the disputed transaction/proof); this contract only enforces that the
same identifier can never be slashed against twice.

## 7. Treasury destination

Mirrors `sweep_fees`'s existing shape exactly (`admin.rs:172-202`): `slash` takes a
caller-supplied `treasury: Address` parameter per call rather than a stored configuration value.
This avoids a second "where do slashed funds go" admin-configuration entry point when the existing
per-call pattern already does the job and is a precedent reviewers already know.

## Storage keys (pinned)

```rust
DataKey::KeeperStake(Address)              // i128, a keeper's current bonded stake
DataKey::UnbondRequest(Address)            // (i128 amount, u32 release_ledger), at most one in-flight request per keeper
DataKey::SlashIncident(BytesN<32>)         // (), presence = this incident_id has already been slashed
```

`UnbondRequest` deliberately holds at most one pending request per keeper (a second
`initiate_unbond` call while one is already pending replaces it, using the new total) rather than
a list — this epic's issues do not require concurrent partial unbonds, and a single-slot design is
simpler to reason about and test.

## Error variants (pinned, starting at the next free discriminant, 25)

```rust
InsufficientStake = 25,       // withdraw/unbond/slash amount exceeds current stake
SlashExceedsStake = 26,       // slash amount > keeper's current stake (clamped, see below)
DuplicateSlashIncident = 27,  // incident_id already slashed once
UnbondNotReady = 28,          // withdraw_stake called before the delay elapsed
NoUnbondRequest = 29,         // withdraw_stake called with nothing pending
InvalidStakeAmount = 30,      // non-positive amount passed to stake_deposit/initiate_unbond/slash
```

**Slash bounds decision:** `slash` returns `Err(SlashExceedsStake)` rather than silently clamping
to the keeper's current stake. A caller (the admin) that asks to slash more than a keeper has
staked is very likely working from stale information (the keeper already partially unbonded, or a
concurrent slash already reduced the stake) — surfacing that loudly is safer than silently slashing
a smaller amount than intended and reporting success. See invariant impact in §8.

## Entry point signatures (pinned)

```rust
pub fn stake_deposit(e: Env, keeper: Address, amount: i128) -> Result<(), KeeperError>;
pub fn initiate_unbond(e: Env, keeper: Address, amount: i128) -> Result<u32, KeeperError>; // returns release_ledger
pub fn withdraw_stake(e: Env, keeper: Address) -> Result<i128, KeeperError>; // returns amount withdrawn
pub fn slash(
    e: Env,
    admin: Address,
    keeper: Address,
    amount: i128,
    reason: Symbol,
    incident_id: BytesN<32>,
    treasury: Address,
) -> Result<(), KeeperError>;

// Views
pub fn keeper_stake(e: Env, keeper: Address) -> i128;
pub fn unbonding_status(e: Env, keeper: Address) -> Option<(i128, u32)>; // (amount, release_ledger)
pub fn is_slash_incident_recorded(e: Env, incident_id: BytesN<32>) -> bool;
```

`reason` is a `Symbol` (9-char limit, matching every other short-code field this contract already
uses — e.g. event topics), not an arbitrary string, since Soroban events and storage favor bounded
types. A future issue could extend this to a longer `Bytes` payload if a 9-character reason code
proves too restrictive in practice; not needed for this epic's scope.

## Invariant impact

`invariants::assert_solvent` (I-1) must be extended: `token_balance == open_escrow +
keeper_balances + fees_accrued + stake_total`. This implementation updates the function's
signature and both call sites in `test/property.rs` accordingly. `I-5` (escrow isolation) is
**not** extended to cover stake — `slash` is an admin action that legitimately moves stake by
design, so an isolation invariant that included stake would be actively wrong here; this is
recorded explicitly rather than left as a silent gap between the invariant's doc comment and its
actual (correct) scope.

## Scope of this implementation

This document, together with the code in this PR, covers backlog issues **0289** (stake storage +
`stake_deposit`), **0290** (unbonding: `initiate_unbond` + `withdraw_stake`), and **0291**
(`slash` + its authorization model) as the minimal real primitive GitHub issue #419 needs to exist
against, plus GitHub issues **#423** (CEI review of all three new entry points, with reentrancy
regression tests), **#431** (CPU-instruction regression ceilings for all four new entry points),
and **#429** (keeper-bot auto-staking — see `examples/keeper-bot/README-STAKING.md` for that
issue's own scope correction, since backlog 0301's target directory, `keeper-bot-v2`, does not
exist in this repository).

**Explicitly out of scope, left for future E06 issues:** 0292 (minimum stake to `claim_task` — a
decision issue that may conclude "not required"; not decided here, since none of the four assigned
issues need it), 0296 (a dedicated events audit — this implementation emits `StakeDeposited`,
`UnbondInitiated`, `StakeWithdrawn`, and `Slashed` as part of building the entry points themselves,
but does not separately update the README event table, since that is 0296's own acceptance
criterion, not #419/#423/#429/#431's), 0297 (this implementation exposes `keeper_stake`,
`unbonding_status`, and `is_slash_incident_recorded` as a byproduct of needing them for its own
tests, but the exact naming/shape audit 0297 asks for is not separately performed), dispute-based
slashing, and any stake-gated behavior on `claim_task`/`execute_task`.
