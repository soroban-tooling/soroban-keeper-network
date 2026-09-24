# Staking Security Review (Epic E06, issue #439 / 0311)

## Purpose and scope

Epic E19 (Security & Audit Readiness) asks that every implementation epic
close with a dedicated security pass before any of it is considered ready
for a real deployment carrying real value, mirroring the discipline already
applied to the verifier epic (issue 0089, `docs/VERIFIER_DESIGN.md` §"Trust
model") and the indexer (issue 0248). This document is that pass for the
staking, unbonding, dispute-window, and slashing surface introduced by
issues 0289-0293 / #422 and implemented in
`contracts/keeper-registry/src/staking.rs`, per `docs/STAKING_DESIGN.md`.

This is a review of what shipped, not a restatement of the design document.
Where a finding below required a code change, the change is described and
the corresponding regression test is named; where a concern was checked and
does not apply, that is stated as a confirmation, not silently assumed.

Per issue #439's explicit instruction, this review covers at minimum:

1. Whether the slash authorization model has a single point of failure.
2. Whether the dispute window can be gamed by timing a withdrawal attempt.
3. Whether unbonding has any path to bypass the delay.
4. Whether the appeal process can be used to indefinitely stall a
   legitimate slash.

Three findings were confirmed and fixed during this review (§1-3 below);
none were left open, per this issue's acceptance criteria that any finding
is fixed before the epic closes.

## Finding 1: Unbonding as a slash-evasion path (fixed)

**Severity: High. Status: Fixed, with regression tests.**

### The vulnerability

`initiate_unbond` moves `amount` out of `DataKey::KeeperStake` immediately,
well before `UNBOND_DELAY_LEDGERS` (~5 days) elapses — the funds land in
`DataKey::UnbondRequest` instead, still fully within the contract's
custody, but no longer counted by `keeper_stake_of`. `slash`'s original
implementation validated `amount <= keeper_stake_of(keeper)` and drew only
from `DataKey::KeeperStake`.

The consequence: a keeper who saw scrutiny coming — or simply front-ran the
admin's `slash` transaction after submitting fraudulent work — could call
`initiate_unbond` for their entire stake and reduce their slashable balance
to exactly zero. `slash` would then fail with `InsufficientStake`
regardless of how much stake the keeper had moments earlier, even though
every unit of it was still sitting inside the contract, not withdrawn, and
would not become withdrawable for another five days. This defeated the
entire purpose of the unbonding delay as stated in `docs/STAKING_DESIGN.md`
§3: *"If a keeper could deposit stake, misbehave, and withdraw before
anyone could raise a dispute or before an admin could slash, staking would
provide no actual accountability."* The delay protected against
*withdrawal* timing, but did nothing to protect against *unbonding* timing
specifically — and unbonding, not withdrawal, is the step that actually
removes slashability.

Confirmed empirically before the fix: staking 1,000,000 units, unbonding
all of it, then attempting to slash 1,000,000 units returned
`InsufficientStake` rather than succeeding.

### The fix

`slash` now computes total slashable exposure as `KeeperStake +
UnbondRequest.amount` (if a request is pending), validates `amount`
against that sum, and draws from `KeeperStake` first, then from the
pending unbond amount for any remainder still needed. A fully-consumed
unbond request is removed; a partially-consumed one has its `amount`
reduced, with its `unlock_ledger` left untouched — slashing does not
change when the rest becomes withdrawable, it only reduces how much there
is left to withdraw.

This does not weaken the unbonding delay's own guarantee: funds that have
actually finished the delay and been withdrawn via `withdraw_stake` are, as
before, outside the contract entirely and no longer slashable — that is
the delay doing exactly its documented job. The fix only closes the gap
*during* the delay, which is precisely the window the delay exists to
protect.

**Interaction with an upheld appeal, checked:** if a slash partially or
fully draws from a pending unbond and the keeper later successfully
appeals it (§3), `resolve_slash_appeal` credits the refund back into
`KeeperStake` (fully bonded), not back into the original `UnbondRequest`.
A keeper made whole this way must call `initiate_unbond` again and wait
the full delay to withdraw the refunded amount, rather than resuming the
original request's already-partially-elapsed timer. This is strictly more
conservative than restoring the exact prior state, not a new gap.

**Regression tests** (`contracts/keeper-registry/src/test/staking.rs`):
`test_slash_draws_on_pending_unbond_when_keeper_stake_is_insufficient`,
`test_slash_fully_consumes_and_removes_pending_unbond`,
`test_slash_draws_from_keeper_stake_before_pending_unbond` (confirms an
unrelated pending unbond is untouched when `KeeperStake` alone covers the
slash), `test_slash_still_rejects_amount_exceeding_stake_plus_pending_unbond`.

## Finding 2: Dispute-window boundary mismatch (fixed)

**Severity: Medium. Status: Fixed, with regression tests.**

### The vulnerability

Two independent checks govern the fate of an `execute_task` credit sitting
in `DataKey::PendingReward` once `DisputeWindowLedgers > 0`:

- `dispute_execution` rejected a dispute once `now > credit.unlock_ledger`
  (strictly greater).
- `finalize_rewards` (called from `withdraw_rewards`) finalized a credit
  once `now >= credit.unlock_ledger` (at or after).

At exactly `now == credit.unlock_ledger`, both conditions could be
simultaneously satisfiable: `dispute_execution` would still accept a
dispute at that ledger, and `withdraw_rewards` would also be willing to
finalize the same credit at that same ledger. The outcome for a credit
sitting at that boundary depended on which transaction actually landed
first within the ledger — a race, not a deterministic rule. This was not
an oversight: a prior version of the test suite
(`test_dispute_execution_boundary_exactly_at_unlock_ledger_still_allowed`)
explicitly asserted the dispute side of this race and documented, in its
own comment, that `dispute_execution` "must win the race if it is the call
that actually lands" — naming the race without closing it.

Every other "has this delay window elapsed" check in this codebase uses
the inclusive `>=` convention (`lock_expired`, `finalize_rewards` itself,
and `withdraw_stake`'s boundary, which explicitly documents mirroring
`lock_expired`). `dispute_execution`'s `>` was the one outlier.

### The fix

`dispute_execution` now rejects with `DisputeWindowClosed` once `now >=
credit.unlock_ledger`, matching `finalize_rewards`'s boundary exactly. A
credit at precisely `unlock_ledger` is now deterministically "already
finalizable, no longer disputable" regardless of transaction ordering
within that ledger — the dispute window must close no later than
finalization opens.

**Regression tests**: the prior boundary test was renamed and its assertion
reversed —
`test_dispute_execution_boundary_exactly_at_unlock_ledger_is_too_late`
(now asserts `DisputeWindowClosed` at the boundary) — and a new
`test_dispute_execution_boundary_one_ledger_before_unlock_is_still_allowed`
confirms the window remains fully usable one ledger earlier, so the fix
narrows the boundary by exactly one ledger rather than shrinking the
window itself.

## Finding 3: `raise_slash_appeal` never renewed TTL (fixed)

**Severity: Medium. Status: Fixed, with a regression test.**

### The vulnerability

`raise_slash_appeal` is a state-mutating entry point — it writes
`record.appealed = true` back to `DataKey::Slash(slash_id)` — but called
neither `bump_instance` nor `extend_ttl` on the record it had just
updated, unlike `slash`, `stake_deposit`, `initiate_unbond`, and every
other staking entry point that mutates persistent state (this is the same
class of gap issue #440 closed for the four entry points it named
explicitly; `raise_slash_appeal` is a fifth staking entry point in the same
file that had the identical gap, found during this review rather than
issue #440's own pass).

`resolve_slash_appeal` has no deadline — §4.1's own design reasoning notes
the admin is trusted the same way for every other action, with no
timelock. This is intentional and not itself a finding (see §4). But
combined with the missing TTL renewal, a real, promptly-raised appeal
(well within `DISPUTE_WINDOW_LEDGERS`) relied entirely on the *original*
`slash` call's TTL bump to keep the instance and the `Slash` record alive
until whenever the admin got around to resolving it. If the admin took
long enough — specifically, longer than the time remaining on that
original bump when the appeal was raised — the whole registry instance
(not just this one record) could archive before `resolve_slash_appeal`
ever ran, at which point resolving the appeal becomes impossible without
an out-of-band `RestoreFootprint` operation, and every other call to the
registry fails too in the meantime.

Confirmed empirically: staking, slashing, raising an appeal after the
original bump's TTL had already dropped below its renewal threshold, then
advancing past where that original bump would have expired reproduced a
host-level archived-entry panic on `resolve_slash_appeal`.

### The fix

`raise_slash_appeal` now calls `bump_instance` and extends the `Slash`
record's own TTL, exactly mirroring `slash`'s own pattern for the same
record. Raising an appeal now keeps both the instance and the specific
record it touches alive for a fresh `KEEPER_BALANCE_BUMP_LEDGERS` window
from the appeal, independent of how much headroom the original slash's
bump had left.

**Scope note on `KeeperStake`'s own TTL:** this fix does not, and does not
need to, guarantee `DataKey::KeeperStake(keeper)`'s own liveness
independent of the appeal/resolution path. That entry follows the same
documented, accepted tradeoff `docs/ARCHITECTURE.md` already states for
`KeeperReward`: a persistent balance not touched by its *own* subsequent
activity can independently archive, recoverable via `RestoreFootprint`,
not a fund-loss bug. If an admin resolves an appeal by upholding it
(crediting `KeeperStake`) long after every other renewal has lapsed, that
specific read can still hit the same pre-existing, already-accepted class
of archival — a different, narrower exposure than this finding, and not a
new one introduced by staking.

**Regression test**
(`contracts/keeper-registry/src/test/ttl.rs`):
`test_raise_slash_appeal_renews_ttl_so_resolution_survives_a_slow_admin`.

## Finding 4 (confirmed, no change needed): Slash authorization is a single point of failure — by design, already studied

**Status: Confirmed as a known, explicitly accepted risk. No code change.**

`slash` is authorized exactly like every other admin action
(`require_admin`): one `Address` in `DataKey::Admin`, no multisig, no
timelock, no separate slash-specific role. This is unambiguously a single
point of failure — a compromised admin key can slash any keeper's stake
(and, per Finding 1's fix, any pending unbond) to zero.

This is not a gap this review is discovering; it is the explicit,
deliberately-reasoned decision in `docs/STAKING_DESIGN.md` §4.1, restated
here because issue #439 asks for it to be addressed directly rather than
assumed covered by the design doc: *"The post-slash shape is chosen
because... it mirrors the trust model the registry already has: the admin
is already a fully trusted party for `sweep_fees`, `set_fee_bps`, and
`transfer_admin`, with no on-chain checks-and-balances beyond
`require_auth`."* The same design doc's own feasibility study (§"Feasibility
— batch slashing for a systemic incident") independently reasons through
the blast-radius consequences of concentrating slashing power and
explicitly declines to build `batch_slash` for exactly this reason —
"repeated single `slash` calls are an acceptable operational cost" against
"concentrating arbitrarily large slashing power... behind one call."

**This review's finding:** the single-key admin trust model is a real,
material risk for any deployment where the admin key's compromise would be
catastrophic, and it should be named explicitly in any audit or
deployment-readiness checklist — not fixed here, because fixing it (a
genuine multisig or timelock on `slash` specifically) is out-of-scope
design work the existing study already identifies as its own follow-up,
not something to smuggle into a security-review issue. Recommendation:
before any mainnet deployment carrying meaningful value, revisit whether
`slash` specifically (not necessarily every admin action) should sit
behind a higher bar than a single key — a multisig or timelock scoped to
slashing alone, leaving the lower-stakes admin actions (`sweep_fees`,
`set_fee_bps`) on the existing single-key model, would change the
"one compromised key, unbounded blast radius" tradeoff without adopting
`batch_slash`'s rejected shape.

## Finding 5 (confirmed, no change needed): Appeal process cannot stall a legitimate slash

**Status: Confirmed does not apply. No code change.**

Checked directly: could a slashed keeper use the appeal mechanism to
indefinitely delay or block a legitimate slash from taking effect?

It cannot, by construction of the post-slash (not pre-slash-hold) design
(§4.1). `slash` moves the disputed funds to `treasury` unconditionally, in
the same transaction, before any appeal exists. There is nothing left
"pending" for an appeal to stall — the slash has already fully executed by
the time `raise_slash_appeal` could even be called. Raising an appeal only
flags the historical record for the admin's attention; it does not reverse,
pause, or hold anything. The only party who can *resolve* an appeal
(uphold or reject it) is the admin, and the keeper has no lever to force,
delay, or prevent that resolution from the keeper's side — `keeper.
require_auth()` gates only `raise_slash_appeal` (raising the appeal once,
within the window), not `resolve_slash_appeal` (admin-only, no keeper
involvement in resolution at all).

The one genuine timing dependency here is the inverse of "stalling a
slash": Finding 3 above (now fixed) was about an appeal's *own* resolution
being at risk of stalling indefinitely due to a missing TTL renewal — not
about a keeper using the appeal process to stall the slash that already
happened.

## Finding 6 (confirmed, no change needed): Execution dispute window cannot be gamed via `finalize_rewards`'s cross-credit batching

**Status: Confirmed does not apply. No change beyond Finding 2.**

`finalize_rewards` walks every pending credit for a keeper in one pass and
finalizes each independently based on its own `disputed` flag and
`unlock_ledger` — checked directly in
`test_multiple_pending_credits_finalize_independently`. A keeper with
several credits at different unlock ledgers cannot use one credit's
maturity to force an unrelated, still-disputed or still-pending credit to
finalize alongside it; each credit's eligibility is evaluated on its own
terms every time `finalize_rewards` runs. Beyond the single-credit boundary
race already covered by Finding 2, there is no cross-credit timing
manipulation available.

## Summary

| # | Concern (from issue #439) | Outcome |
|---|---|---|
| 1 | Slash authorization single point of failure | Confirmed as a known, deliberately-accepted risk (design doc's own study); recommendation given for a future, separately-scoped multisig/timelock on `slash` specifically. No code change in this review. |
| 2 | Dispute window gamed by timing | **Fixed** — boundary mismatch between `dispute_execution` (`>`) and `finalize_rewards` (`>=`) closed; both now `>=`. |
| 3 | Unbonding bypasses the delay | **Fixed** — `slash` now draws on pending unbond amounts, closing the front-run-an-unbond evasion path. |
| 4 | Appeal process stalls a legitimate slash | Confirmed does not apply — the post-slash design has already executed the slash before an appeal can exist. (A different appeal-resolution liveness gap was found and fixed — see #3 in the numbered findings above, "Finding 3.") |

No finding was left open. Three code changes shipped with this review, each
with a named regression test; two concerns were checked and confirmed not
to apply, with the reasoning stated rather than assumed.

## For a future external auditor

Start from this document and `docs/STAKING_DESIGN.md` together — the design
doc for intent and rationale, this document for what was actually checked
against the shipped code and what changed as a result. The three fixes
above are small, targeted diffs against `contracts/keeper-registry/src/
staking.rs`; reviewing them against their named regression tests (all in
`contracts/keeper-registry/src/test/staking.rs` and `.../test/ttl.rs`) is
the fastest way to confirm each finding's fix independently. Finding 4's
recommendation (a stronger authorization gate on `slash` specifically) is
the one open, explicitly out-of-scope item this review surfaces for a
deployment-readiness decision, not an implementation gap in what shipped.

This document should be added to `docs/AUDIT_SCOPE.md`'s scope table as the
primary artifact for the staking surface (epic E06), alongside
`docs/STAKING_DESIGN.md`.
