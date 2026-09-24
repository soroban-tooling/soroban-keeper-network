# Staking & Slashing Design (Epic E06)

## Context

The registry currently has no concept of keeper reputation or accountability
beyond the lock-window mechanic that prevents a squatting keeper from holding
a task forever (wave 1 issue 0016). This document opens epic E06: a keeper
posts collateral ("stake"), and misbehavior can result in losing some of it
("slashing"). It follows the same discipline `docs/VERIFIER_DESIGN.md`
established for epic E04: every open question is answered with an explicit
decision and rationale, and the exact storage keys and entry point signatures
are pinned here so issues 0289 onward implement against a fixed design rather
than each guessing independently.

## 1. Dependency on the verifier epic (E04)

**Decision: staking does *not* depend on E04's verifier work landing.**

E04 was designed in `docs/VERIFIER_DESIGN.md` but the actual on-chain proof
verification it describes was never implemented — `Task` has an optional
`verifier` field and `execute_task` calls it when present, but no shipped
verifier contract exists yet, and nothing in the registry today can
automatically determine that a keeper's submitted proof was fraudulent.

Given that, **slashing in this first version is dispute-based, not
automatic.** There is no on-chain check this epic can hook into to trigger a
slash by itself. A slash is a deliberate, authorized action (§4) taken in
response to evidence gathered off-chain, not a consequence the contract
derives on its own from a failed verification. If and when E04's verifier
work lands, a future issue can wire an on-chain verification failure into an
automatic slash trigger — that is out of scope here and not assumed.

## 2. Where stake lives

**Decision: a separate stake escrow in this same contract, tracked under its
own storage key, not a dedicated staking contract.**

The tradeoff, stated plainly: a separate contract would isolate stake-related
bugs from task escrow entirely, at the cost of a cross-contract call on every
stake-checked operation (every `claim_task`, if a minimum stake is enforced —
see §5) and a second contract to deploy, initialize, and keep in sync with
the registry's admin/pause state.

Same-contract wins here for the same reason `KeeperReward` and `FeesAccrued`
already live beside task escrow rather than in their own contracts: this
registry's existing separation-of-concerns discipline is storage-key
isolation (a bug in one key's accounting cannot touch another key), not
contract isolation, and that has held so far. A new `DataKey::KeeperStake`
variant gets the same guarantee `KeeperReward` already has — one storage key
per Rust type, one line of code away from any other balance — without a
cross-contract call tax on every stake check. If a future security review
finds this insufficient, splitting stake into its own contract remains
possible later; nothing in this design forecloses it.

## 3. Unbonding

**Decision: withdrawal is delayed, not immediate.**

If a keeper could deposit stake, misbehave, and withdraw before anyone could
raise a dispute (§4) or before an admin could slash, staking would provide no
actual accountability — the collateral would only ever be at risk for
callers who forgot to withdraw it. An unbonding delay closes that window: a
keeper requests to unbond `amount`, and the funds are not withdrawable until
`UNBOND_DELAY_LEDGERS` have elapsed.

`UNBOND_DELAY_LEDGERS = 86_400` (~5 days at 5s/ledger). This deliberately
exceeds `DISPUTE_WINDOW_LEDGERS` (§4, ~3 days) so a dispute raised against
recent behavior always has time to be filed and a slash applied before the
stake that would back it becomes withdrawable, and is deliberately kept
below `INSTANCE_BUMP_LEDGERS` (~6 days, the ledger window a single
mutating call renews the contract instance's storage TTL for): an unbonding
delay longer than that window would mean a keeper's unbond request, if no
other contract traffic happened to land in the interim, could outlive the
instance's own storage TTL. Keeping the delay strictly below the renewal
window makes that scenario impossible regardless of how much (or little)
other activity the registry sees while a request is pending.

## 4. Dispute windows

There are two distinct dispute windows in this design, covering two
different things, and they are deliberately not unified into one
mechanism: §4.1 is a window to appeal a slash *after* it happens (issue
0302 / #430); §4.2 is a window that holds a freshly-executed task's
*reward* before it becomes withdrawable, so its execution itself can be
disputed (issue 0293 / #421). A slash acts on a keeper's *stake*; the
execution dispute window acts on a keeper's *reward*. They interact (§4.2
routes an upheld execution dispute into the same `slash` entry point
§4.1's appeal path can itself reverse), but neither is a special case of
the other, and conflating them into one "dispute" concept would blur what
each is actually protecting.

### 4.1 The post-slash appeal window

**Decision: a fixed post-slash appeal window, not a pre-slash hold.**

Two shapes were considered:

- **Pre-slash hold**: a party raises a dispute *before* any slash occurs;
  funds are frozen pending resolution; a resolver (admin) then decides
  slash-or-release. This requires a three-state stake lifecycle (`normal`,
  `disputed`, `resolved`) and a dispute-initiation entry point with its own
  authorization model.
- **Post-slash appeal** (chosen): the admin (or a role the admin appoints —
  see §4.1.1) can slash directly, the same way `sweep_fees` and `set_fee_bps`
  are already trusted admin actions with no separate approval step. A slashed
  keeper then has `DISPUTE_WINDOW_LEDGERS` from the slash to raise an appeal.
  If upheld, the admin reverses the slash (credits the stake back); if the
  window elapses with no successful appeal, the slash is final.

The post-slash shape is chosen because it needs no new stake-state machine —
a stake is either present or it isn't, exactly like `KeeperReward` today —
and because it mirrors the trust model the registry already has: the admin
is already a fully trusted party for `sweep_fees`, `set_fee_bps`, and
`transfer_admin`, with no on-chain checks-and-balances beyond `require_auth`.
A pre-slash hold would imply a higher trust bar for slashing specifically
than the registry places on every other admin action, which is inconsistent
without a stated reason to treat slashing differently.

`DISPUTE_WINDOW_LEDGERS = 51_840` (~3 days at 5s/ledger).

#### 4.1.1 Who can raise a dispute, and what happens to the stake meanwhile

The slashed keeper itself is the only party who can raise an appeal against
its own slash (`raise_slash_appeal(keeper, slash_id)`, `keeper.require_auth()`
required) — third parties have no standing to dispute a slash they were not
subject to. While an appeal is pending, the disputed amount has *already*
moved to the treasury (§5) — this is a post-slash appeal, not a hold — so
"what happens to the stake while a dispute is pending" is: nothing; it is
already transferred. This keeps the invariant that a completed `slash` call
has exactly one well-defined effect (funds move), rather than a conditional
one that depends on a later, separate resolution.

A successful appeal is therefore a genuine *refund*, not an internal
bookkeeping reversal: the contract does not hold the disputed funds in
escrow while the appeal is pending, so crediting the keeper's stake back
without an actual transfer into the contract would break solvency (I-1,
`docs/ARCHITECTURE.md`). `resolve_slash_appeal(admin, slash_id,
uphold_appeal: true)` therefore requires `admin.require_auth()` and pulls
`record.amount` from `admin` into the contract (the same shape
`stake_deposit` already uses for a self-funded transfer) before crediting
the keeper — the admin is expected to have moved the funds back from
`treasury` off-chain first, the same way `sweep_fees`'s destination address
is the admin's own choice and this contract has no visibility into what
happens to swept funds afterward.

### 4.2 The execution dispute window (issue 0293 / #421)

**Decision: a global, admin-configurable hold on freshly-credited rewards,
disabled by default, rather than a change to `register_task`'s signature.**

Unlike the slash appeal (§4.1, which acts after the fact on a keeper's
*stake*), this window acts *before* a reward becomes spendable at all:
every `execute_task` credit is held for a configurable number of ledgers
before it can be withdrawn. That duration is its own constant,
`EXECUTION_DISPUTE_WINDOW_LEDGERS`, deliberately separate from §4.1's
`DISPUTE_WINDOW_LEDGERS` — there is no reason "how long can a task's
execution be disputed" and "how long can a slash be appealed" should share
one number; they bound different risks, and a future change to one should
not silently move the other.

Two shapes were considered for *where* this window is configured:

- **Per-task, via a new `register_task` parameter** (e.g.
  `dispute_window: Option<u32>`): lets a task owner opt individual
  high-value tasks into the protection without changing behavior for every
  task. Rejected for this first version because it touches `register_task`,
  `batch_register_tasks`, and `BatchTaskParams` simultaneously — three call
  sites whose existing tests and ABI shape this epic should not need to
  touch to ship staking — and because 0293 itself does not ask for
  per-task granularity, only that the mechanism exist.
- **Global, admin-configured** (chosen): one `set_dispute_window(admin,
  ledgers)` entry point, mirroring `set_min_stake`/`set_min_reward`'s
  existing opt-in-via-admin-config pattern exactly. Default `0`
  (disabled) is byte-identical to the existing wave-1 MVP behavior, where
  an `execute_task` credit is immediately withdrawable — exactly what
  `test_keeper_balance_accumulates_across_tasks_and_withdraws_as_one_sum`
  already locks in and must keep passing unmodified. An admin that wants
  the protection turns it on for the whole registry; one that doesn't
  (or hasn't decided yet) pays no new complexity at all. Capped at
  `MAX_EXECUTION_DISPUTE_WINDOW_LEDGERS` (~5 days), for the identical
  reason `UNBOND_DELAY_LEDGERS` is bounded below the instance-TTL renewal
  window (§3): a hold longer than that window could let a pending credit
  outlive its own storage TTL before it is ever finalized.

### What actually changes in `execute_task` / `withdraw_rewards`

`execute_task`'s existing effect — `credit_keeper` writing directly into
`DataKey::KeeperReward` — is preserved exactly when the window is `0`. When
it is greater than `0`, the credit instead becomes a `PendingCredit` (task
id, net reward, `unlock_ledger = current_ledger +
EXECUTION_DISPUTE_WINDOW_LEDGERS`) appended to `DataKey::PendingReward(keeper)`.

`withdraw_rewards` gains a first step, `finalize_rewards`: walk the
keeper's pending credits, move every one whose `unlock_ledger` has passed
and that was never disputed into `KeeperReward` (exactly the amount, via
the same `credit_keeper` helper `execute_task` already uses), and remove it
from the pending list. Only *then* does the existing zero-and-transfer logic
run, against whatever `KeeperReward` now holds. A keeper with several
pending credits at different unlock ledgers therefore withdraws whatever
has finalized so far on each call — nothing new is required to fix I-6
(withdrawal liveness): a keeper's *finalized* balance remains withdrawable
at any time (including while paused, unchanged), and a still-pending credit
was never counted as "credited" for I-6's purposes in the first place, the
same way an open task's escrow (not yet a keeper balance at all) has never
been covered by I-6 either.

### Disputing an execution

`dispute_execution(owner, task_id)` — the **task's owner**, not any third
party, has standing (they are the one who paid for the task and is best
positioned to know whether it was genuinely executed correctly; this
mirrors `cancel_task`'s existing owner-only authorization rather than
inventing a new role). Requires `owner.require_auth()` and `owner` matching
the task's stored `owner`. Marks the matching `PendingCredit` `disputed =
true` if it exists and its `unlock_ledger` has not yet passed
(`DisputeWindowClosed` otherwise) — a disputed credit is excluded from
`finalize_rewards` (neither paid out nor silently dropped) until resolved.

`resolve_execution_dispute(admin, task_id, uphold_dispute: bool)` —
admin-only, the same trust boundary `slash`/`resolve_slash_appeal` already
use. `uphold_dispute = true` removes the `PendingCredit` without ever
crediting `KeeperReward` (the reward is never paid), and the admin is
expected to follow up with a `slash` call against the keeper's stake if the
dispute's underlying misbehavior warrants it — this design deliberately
does not auto-slash from a resolved dispute, for the same reason `slash`
itself requires an explicit `reason` and explicit admin action rather than
being triggered automatically (§1: there is no on-chain signal here more
trustworthy than there was for E04's unimplemented verifier). `uphold_dispute
= false` clears the `disputed` flag, returning the credit to the normal
finalization path once its `unlock_ledger` passes.

## 5. The slash mechanism

**Decision: `slash(admin, keeper, amount, reason)`, admin-authorized, funds
move to a treasury address matching `sweep_fees`'s existing pattern.**

```rust
pub fn slash(
    e: Env,
    admin: Address,
    keeper: Address,
    amount: i128,
    reason: Symbol,
    treasury: Address,
) -> Result<u64, KeeperError>; // returns a slash_id for later appeal reference
```

- Authorized exactly like every other admin action (`require_admin`):
  `admin.require_auth()`, and `admin` must equal the stored `DataKey::Admin`.
  No new authorization role is introduced in this version — see §4's
  reasoning for why the existing admin trust boundary is reused rather than
  widened.
- `amount` is capped at the keeper's current stake (`amount <=
  keeper_stake(keeper)`); a slash can never remove more than is actually
  staked, and cannot leave a negative balance.
- Funds move to `treasury`, consistent with how `sweep_fees` already routes
  protocol fees to a treasury address rather than burning them — slashed
  stake is protocol revenue analogous to fees, not destroyed value.
- Emits `Slashed(slash_id, keeper, amount, reason)` carrying enough
  information to reconstruct why a slash occurred from the indexer's event
  history alone (§ "Events" below).
- A `slash_id` (a `u64` counter, mirroring `TaskCounter`'s pattern) is
  returned and recorded so a later `raise_slash_appeal` call can reference
  exactly which slash it disputes — this also gives §4.1's "cannot be
  applied twice for the same underlying incident" a concrete handle: each
  `slash_id` is independent, one-shot, and appealable exactly once.

## 6. Interaction with existing mechanics

**Decision: a staked keeper gets no different treatment in `claim_task` or
`execute_task` in this first version — except the minimum-stake requirement,
which is itself opt-in and configurable (issue 0292).**

No priority queue, no lower effective lock window, nothing that changes the
existing task-claiming fairness model for a staked keeper versus an unstaked
one. The only behavior change staking introduces to the existing entry
points is whatever `set_min_stake`/`claim_task` gate issue 0292 implements,
and that gate defaults to `0` (no requirement) until an admin explicitly
configures otherwise — the same "off by default, opt-in via admin config"
posture `min_reward`/`MinReward` already established for the task side.

## Storage keys (pinned)

| Key | Type | Storage | Meaning |
|-----|------|---------|---------|
| `KeeperStake(Address)` | `i128` | Persistent | A keeper's currently-staked (bonded) amount. Excludes anything mid-unbond. |
| `UnbondRequest(Address)` | `UnbondRequest` struct (`{ amount: i128, unlock_ledger: u32 }`) | Persistent | At most one pending unbond per keeper. A second `initiate_unbond` while one is pending is rejected (see 0290's own acceptance criteria) rather than silently overwriting the first. |
| `MinStake` | `i128` | Instance | Configurable floor `claim_task` enforces, if any. Default `0` (no requirement), mirroring `MinReward`. |
| `SlashCounter` | `u64` | Instance | Monotonic id source for `slash_id`, mirroring `TaskCounter`. |
| `Slash(u64)` | `SlashRecord` struct (`{ keeper: Address, amount: i128, reason: Symbol, ledger: u32, appealed: bool }`) | Persistent | One record per slash, looked up by `raise_slash_appeal`. |
| `DisputeWindowLedgers` | `u32` | Instance | Configurable execution-dispute hold `execute_task` credits go through. Default `0` (disabled — a credit is withdrawable immediately, the unmodified wave-1 MVP path). See §4.2. |
| `PendingReward(Address)` | `Vec<PendingCredit>` (`{ task_id: u64, net_reward: i128, unlock_ledger: u32, disputed: bool }`) | Persistent | A keeper's not-yet-finalized `execute_task` credits. Only populated when `DisputeWindowLedgers > 0`. |

## Entry point signatures (pinned)

```rust
// 0289
pub fn stake_deposit(e: Env, keeper: Address, amount: i128) -> Result<(), KeeperError>;
pub fn keeper_stake(e: Env, keeper: Address) -> i128; // view, mirrors keeper_balance's shape

// 0290
pub fn initiate_unbond(e: Env, keeper: Address, amount: i128) -> Result<(), KeeperError>;
pub fn withdraw_stake(e: Env, keeper: Address) -> Result<i128, KeeperError>; // returns amount withdrawn

// 0291
pub fn slash(e: Env, admin: Address, keeper: Address, amount: i128, reason: Symbol, treasury: Address) -> Result<u64, KeeperError>;

// 0292
pub fn set_min_stake(e: Env, admin: Address, min_stake: i128) -> Result<(), KeeperError>;
// claim_task gains a MinStakeNotMet rejection path when MinStake > 0

// issue 0309 / #437
pub fn min_stake(e: Env) -> i128; // view, mirrors min_reward's shape

// issue 0302 / #430 (appeal, built on this design, not part of 0289-0291's scope)
pub fn raise_slash_appeal(e: Env, keeper: Address, slash_id: u64) -> Result<(), KeeperError>;
pub fn resolve_slash_appeal(e: Env, admin: Address, slash_id: u64, uphold_appeal: bool) -> Result<(), KeeperError>;

// issue 0293 / #421 (execution dispute window, §4.2)
pub fn set_dispute_window(e: Env, admin: Address, ledgers: u32) -> Result<(), KeeperError>;
pub fn dispute_window(e: Env) -> u32; // view
pub fn dispute_execution(e: Env, owner: Address, task_id: u64) -> Result<(), KeeperError>;
pub fn resolve_execution_dispute(e: Env, admin: Address, task_id: u64, uphold_dispute: bool) -> Result<(), KeeperError>;
pub fn pending_reward(e: Env, keeper: Address) -> Vec<PendingCredit>; // view
// withdraw_rewards' existing signature is unchanged; it now internally
// finalizes eligible pending credits before paying out.
```

## New error variants (pinned)

| Variant | Discriminant | When |
|---|---|---|
| `InsufficientStake` | 25 | `slash`/`initiate_unbond` amount exceeds the keeper's current stake. |
| `UnbondNotReady` | 26 | `withdraw_stake` called before `unlock_ledger`. |
| `UnbondAlreadyPending` | 27 | `initiate_unbond` called while a prior request for the same keeper hasn't been withdrawn yet. |
| `NoPendingUnbond` | 28 | `withdraw_stake` called with no `UnbondRequest` on file. |
| `MinStakeNotMet` | 29 | `claim_task` rejects a keeper below the configured `MinStake` floor. |
| `SlashNotFound` | 30 | `raise_slash_appeal`/`resolve_slash_appeal` given an unknown `slash_id`. |
| `AppealWindowClosed` | 31 | `raise_slash_appeal` called after `DISPUTE_WINDOW_LEDGERS` has elapsed since the slash. |
| `AppealAlreadyRaised` | 32 | A second `raise_slash_appeal` for the same `slash_id`. |
| `NotSlashedKeeper` | 33 | `raise_slash_appeal` called by an address other than the slash's own `keeper`. |
| `NoPendingCredit` | 34 | `dispute_execution` given a `task_id` with no matching pending credit for that keeper. |
| `ExecutionAlreadyDisputed` | 35 | A second `dispute_execution` for an already-disputed credit. |
| `DisputeWindowClosed` | 36 | `dispute_execution` called after the credit's `unlock_ledger` has passed. |
| `NoDisputedCredit` | 37 | `resolve_execution_dispute` given a `task_id` with no disputed credit on file. |

## Events (pinned)

Following the existing two-symbol `(verb, noun)` topic pattern:

| Event | Topics | Data |
|---|---|---|
| `StakeDeposited` | `("stkdep", "stake")` | `(keeper: Address, amount: i128, new_total: i128)` |
| `UnbondInitiated` | `("unbond", "stake")` | `(keeper: Address, amount: i128, unlock_ledger: u32)` |
| `StakeWithdrawn` | `("stkwd", "stake")` | `(keeper: Address, amount: i128)` |
| `Slashed` | `("slash", "stake")` | `(slash_id: u64, keeper: Address, amount: i128, reason: Symbol)` |
| `ExecutionDisputed` | `("exdisp", "task")` | `(task_id: u64, keeper: Address)` |
| `ExecutionDisputeResolved` | `("exresolv", "task")` | `(task_id: u64, upheld: bool)` |
| `RewardsFinalized` | `("finalize", "reward")` | `(keeper: Address, task_id: u64, amount: i128)` — emitted once per credit as it finalizes, from inside `withdraw_rewards`. |

## Acceptance criteria (from issue 0288)

- [x] Every question above is answered with an explicit decision and rationale.
- [x] The dependency (or lack of one) on epic E04's unimplemented verifier work is stated plainly (§1: no dependency; slashing is dispute-based).
- [x] Exact storage keys and entry point signatures are pinned before implementation begins (above).

## Feasibility — batch slashing for a systemic incident (issue 0308 / #436)

**Study, not a change**, following the same honest-about-uncertainty framing
`docs/BATCH_OPERATIONS.md` §10 used for its own feasibility study (issue
0099/0203, batch cancel): the question is whether a `batch_slash` entry
point is worth building, and the honest answer may be no.

### The case for it

A single admin call slashing one keeper (§5, `slash`) does not scale if a
systemic incident implicates many keepers at once — a coordinated exploit
attempt where a dozen keepers submitted the same fraudulent proof pattern
before it was caught, for example. Without a batch entry point, responding
requires one `slash` transaction per implicated keeper: N signatures, N
fees, and — more importantly during an active incident — N sequential
transactions before the admin's response is complete, during which the
remaining not-yet-slashed keepers are unaffected.

### The case against it, weighed honestly

**An admin capable of slashing many keepers in one call is a more
attractive target and a more dangerous bug surface than one that can only
slash one at a time.** This is the tradeoff issue 0308 asks to be weighed
explicitly, not skipped, so it is weighed here directly rather than
asserted:

- **Blast radius of a compromised admin key.** Today, a compromised admin
  can call `slash` repeatedly, but each call is a separate transaction the
  admin (or whoever holds the key) must sign and submit — there is no
  single call that empties every keeper's stake in one shot. A
  `batch_slash(admin, entries: Vec<(Address, i128, Symbol)>)` entry point
  changes that: one signature, one transaction, arbitrarily many keepers
  slashed to zero. For a contract whose `slash` authorization model is (by
  §5's decision) the same undifferentiated admin trust every other admin
  action already uses — no multisig, no timelock, no separate
  slash-specific role — concentrating that much damage behind one call is a
  strictly worse security posture than N individually-signed calls, even
  though the admin's authority is unchanged in principle.
- **Blast radius of an implementation bug.** `slash`'s own correctness
  (§5, "never removes more than the keeper's current stake") is
  straightforward to review as a single-keeper operation. A batched version
  has the same class of hazard `batch_register_tasks` (`docs/
  BATCH_OPERATIONS.md` §6-9) and the cancellation study (§10.2) both had to
  reason through carefully for their own loops: does an early entry's write
  affect a later entry's validation within the same call, and is a partial
  failure atomic or does it need its own explicit rollback story. A
  `batch_slash` bug that incorrectly computes even one entry in a large
  batch is now a bug that moves real, uninsured, unrecoverable collateral
  for however many keepers are in that batch, in one transaction, with no
  per-entry confirmation step. `slash`'s single-entry version bounds that
  blast radius to one keeper per bug-triggering call.
- **Is the operational cost of N sequential calls actually prohibitive?**
  Not clearly. A "systemic incident implicating many keepers" is, by its
  own description, a rare event — the opposite of the routine, high-volume
  case `batch_register_tasks` was built for, where the per-call
  transaction-fee/signature overhead recurs constantly and adding it up
  matters. Here, the overhead is paid once, during an incident that is
  itself already unusual enough to require admin intervention. N
  transactions in sequence, submitted as fast as the admin's tooling
  allows, is a real but bounded cost against a security tradeoff that is
  not bounded the same way.

### Recommendation

**Do not build `batch_slash`.** Repeated single `slash` calls are an
acceptable operational cost for the rare case a systemic incident would
matter: the cost is one-time and bounded (N transactions during an already
unusual event), while the benefit of avoiding it (fewer signatures, less
admin time) is smaller than the cost of the security regression it would
introduce (concentrating arbitrarily large slashing power, and an
arbitrarily large single-transaction blast radius for any implementation
bug, behind one call with the same undifferentiated admin trust every other
action in this contract already uses).

If the admin's own transaction-submission tooling needs to slash several
keepers during an incident, the safer version of "batch" here is
client-side: submit N `slash` transactions from a script, not N entries in
one on-chain call. That gets the operational convenience without moving the
security boundary.

This recommendation could change if a future issue first changes the
authorization model itself — e.g. a genuine multisig or timelock gate on
`slash` specifically, distinct from the single-key admin trust every other
action here uses — at which point the "one compromised key, unbounded
blast radius" objection above no longer applies in the same way. That is
explicitly out of scope for this study and would need its own design work,
not an assumption smuggled into a `batch_slash` issue.

No implementation issue is filed for `batch_slash`, per this study's
conclusion that it should not be built as currently scoped.
