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

## 4. Dispute window

**Decision: a fixed post-slash appeal window, not a pre-slash hold.**

Two shapes were considered:

- **Pre-slash hold**: a party raises a dispute *before* any slash occurs;
  funds are frozen pending resolution; a resolver (admin) then decides
  slash-or-release. This requires a three-state stake lifecycle (`normal`,
  `disputed`, `resolved`) and a dispute-initiation entry point with its own
  authorization model.
- **Post-slash appeal** (chosen): the admin (or a role the admin appoints —
  see §4.1) can slash directly, the same way `sweep_fees` and `set_fee_bps`
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

### 4.1 Who can raise a dispute, and what happens to the stake meanwhile

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

## Events (pinned)

Following the existing two-symbol `(verb, noun)` topic pattern:

| Event | Topics | Data |
|---|---|---|
| `StakeDeposited` | `("stkdep", "stake")` | `(keeper: Address, amount: i128, new_total: i128)` |
| `UnbondInitiated` | `("unbond", "stake")` | `(keeper: Address, amount: i128, unlock_ledger: u32)` |
| `StakeWithdrawn` | `("stkwd", "stake")` | `(keeper: Address, amount: i128)` |
| `Slashed` | `("slash", "stake")` | `(slash_id: u64, keeper: Address, amount: i128, reason: Symbol)` |

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
# Staking and Slashing Architecture (E06)

This is the architectural design document for Keeper Staking and Slashing in
the Soroban Keeper Network — the decision record against which issues
0289–0316 are implemented.

**Status: Design Phase.** Opens Epic E06. Defines the collateral, unbonding,
dispute, and slashing mechanisms that introduce economic accountability to
keepers while preserving protocol solvency and permissionless participation.

---

## 1. Context and Problem Statement

In the wave-1 MVP and wave-2 releases, the keeper registry relies entirely on a
time-based lock window (`lock_ledgers`) to mitigate keeper misbehavior
(specifically task squatting, issue 0016). When a keeper claims a task via
`claim_task`, it receives exclusive execution rights for `lock_ledgers`. If the
keeper fails to submit `execute_task` before the lock window lapses, any other
keeper can reclaim the task.

However, this mechanic alone provides **no accountability beyond time loss**:
1. **Zero Financial Disincentive for Fraud**: Keepers post no collateral. A
   keeper can submit fraudulent execution proofs or spam malicious claims at
   virtually zero financial risk beyond minimal network transaction fees.
2. **Squatting Griefing**: A malicious keeper can claim high-value tasks across
   consecutive rounds, holding them hostage for `lock_ledgers` blocks at a time,
   intentionally delaying critical DeFi automations (liquidations, oracle pushes)
   without incurring any capital penalty.
3. **Reputation Blindness**: Integrators and task owners cannot differentiate
   between reliable, well-capitalized professional node operators and ephemeral
   or adversarial actors.

Epic E06 introduces **Keeper Staking and Slashing**: keepers post collateral in
escrow, and verifiable misbehavior results in slashing a portion or all of that
collateral.

---

## 2. What Counts as Slashable & Verifier Dependency

### 2.1 The Dependency on Epic E04 (Verifier Work)

**Explicit Finding and Decision:**
In Epic E04 (`docs/VERIFIER_DESIGN.md`), the `IKeeperVerifier` interface was
designed and the core contract slice was implemented (`Task.verifier: Option<Address>`,
and the verifier invocation hook in `execute_task`). However:
1. `execute_task`'s verifier hook only performs **pre-execution gating**: if
   the verifier returns `false` or panics, `execute_task` returns
   `KeeperError::VerificationFailed`, aborting the execution and leaving the
   task in its claimed state for retry. It does **not** slash the keeper.
2. The deployed contracts do not have a deterministic, universally audited suite
   of on-chain verifiers covering all task types, nor does every registered task
   have a verifier attached (`Task.verifier` is optional and defaults to `None`).
3. If an automated on-chain verifier failure directly triggered immediate
   slashing in the core contract, a malicious task owner could register a task
   pointing to a verifier contract that maliciously returns `false` or panics,
   weaponizing the registry to arbitrarily seize keeper collateral.

**Decision: Slashing in v1 is Dispute-Based with Challenge Windows, NOT Automatic on Verifier Panic.**
Epic E06 **does NOT depend** on full on-chain verifier automation landing first.
Instead, version 1 of staking adopts a **hybrid dispute-resolution model**:
- **Execution Path**: `execute_task` proceeds with existing checks (and verifier
  validation if attached).
- **Post-Execution Dispute Window**: Following `execute_task`, a task enters a
  bounded challenge period (`dispute_window_ledgers`).
- **Slash Trigger**: Slashing is triggered via an authorized `slash` entry
  point resulting from an upheld dispute (raised by the task owner or protocol
  dispute resolver) or an explicit governance/admin decision.

### 2.2 Enumeration of Slashable Offenses

The protocol recognizes three distinct slashable conditions:

| Offense | Detection Mechanism | Penalty | Destination |
| :--- | :--- | :--- | :--- |
| **Fraudulent Proof / Invalid Execution** | Disputed within `dispute_window_ledgers` and verified invalid | Fixed penalty or up to 100% of task reward value in stake | Restitution to task owner + Protocol Treasury |
| **Malicious Task Abandonment / Squatting** | Repeated lock window expirations by the same claimer without execution (when `min_stake` is enforced) | Configurable slash penalty (`slash_abandonment_fee`) | Protocol Treasury (`FeesAccrued`) |
| **Proof Equivocation / Double Submission** | Cryptographic proof that keeper submitted conflicting execution states | Full slash of minimum stake | Protocol Treasury (`FeesAccrued`) |

---

## 3. Where Stake Lives: Architecture & Tradeoffs

A fundamental question for E06 is whether stake collateral lives inside the
existing registry contract or in a separate dedicated staking contract.

### 3.1 Architectural Tradeoffs

```text
Option A: Separate Dedicated Staking Contract
┌─────────────────────────┐         cross-contract call         ┌─────────────────────────┐
│     KeeperRegistry      │ ──────────────────────────────────▶ │     StakingContract     │
│  (Tasks & Rewards Pool) │ ◀────────────────────────────────── │     (Collateral Pool)   │
└─────────────────────────┘         authorization check         └─────────────────────────┘

Option B: In-Contract Isolated Storage (Chosen)
┌─────────────────────────────────────────────────────────────┐
│                       KeeperRegistry                        │
│                                                             │
│  ┌─────────────────────────┐     ┌───────────────────────┐  │
│  │   Task Escrow & Fees    │     │  Keeper Stake Storage │  │
│  │    DataKey::Task(_)     │     │  DataKey::KeeperStake │  │
│  │    DataKey::FeesAccrued │     │  DataKey::Unbonding   │  │
│  └─────────────────────────┘     └───────────────────────┘  │
│           ▲                                   ▲             │
│           └─────────── Strictly Isolated ─────┘             │
└─────────────────────────────────────────────────────────────┘
```

| Evaluation Dimension | Dedicated Staking Contract (Option A) | In-Contract Isolated Storage (Option B) |
| :--- | :--- | :--- |
| **Failure Isolation** | High: Staking bugs cannot directly mutate task escrow data. | High: Strict `DataKey` isolation prevents cross-domain corruption. |
| **Gas & CPU Consumption** | High: Cross-contract call on every `claim_task` and `execute_task` to check stake eligibility. | Minimal: In-memory/host ledger read using native `DataKey`. |
| **Transaction Atomicity** | Complex: Two-phase commit or cross-contract reentrancy risks on slash/claim. | Guaranteed: Atomic transaction execution native to Soroban host. |
| **Upgradability** | Separate upgrades, but complicates address authorization and trust handshakes. | Unified versioning via registry's existing `VERSION` and contract upgrades. |

### 3.2 Decision and Rationale

**Decision: In-Contract Isolated Storage (Option B).**
Stake collateral is held directly in `KeeperRegistry` under dedicated, isolated
`DataKey` variants:
- `DataKey::KeeperStake(Address)`
- `DataKey::UnbondingStake(Address)`

**Rationale:**
1. **High-Frequency Efficiency**: Every `claim_task` call must verify that the
   claiming keeper meets the minimum required stake. A cross-contract call on
   every claim introduces unnecessary CPU and latency overhead into time-sensitive
   DeFi liquidations.
2. **Strict Domain Separation**: Following the pattern established by
   `FeesAccrued` (which is kept strictly distinct from task escrow and keeper
   rewards), `KeeperStake` uses dedicated storage keys. Reward accounting
   (`KeeperReward`) and stake accounting (`KeeperStake`) can never touch or
   corrupt each other's balances.
3. **Solvency Guarantee**: All token deposits transfer into the contract's
   escrow balance, tracked by rigorous mathematical invariants.

---

## 4. Unbonding Mechanics

### 4.1 The Need for an Unbonding Delay

If a keeper could withdraw stake instantaneously, the staking guarantee would
be economically meaningless: a malicious keeper could submit a fraudulent proof
in transaction $N$, and immediately invoke `withdraw_stake` in transaction $N+1$
before the task owner or dispute monitor can inspect the proof.

### 4.2 Unbonding Rules and Lifecyle

1. **Unbonding Request (`initiate_unbond`)**:
   - A keeper specifies an `amount` to unbond.
   - The unbonding amount is immediately deducted from `KeeperStake(keeper)`.
   - The unbonding amount is credited to `UnbondingStake(keeper)` with an
     expiration watermark: `unlock_ledger = current_ledger + unbonding_delay_ledgers`.
2. **Immediate Loss of Active Claim Power**:
   - The moment unbonding is initiated, the funds no longer count towards the
     keeper's active stake. If the remaining active stake drops below
     `min_stake`, subsequent `claim_task` calls will fail with
     `KeeperError::InsufficientStake`.
3. **Delay Duration**:
   - `unbonding_delay_ledgers` is configurable by admin (default: `17,280` ledgers,
     approximately 24 hours at 5 seconds per ledger).
4. **Final Withdrawal (`withdraw_stake`)**:
   - Only succeeds if `current_ledger >= unlock_ledger`.
   - Transfers the unbonded token amount from contract escrow back to the keeper's
     Stellar address.

```text
┌────────────────┐     initiate_unbond()     ┌────────────────┐     current_ledger >= unlock     ┌────────────────┐
│  Active Stake  │ ────────────────────────▶ │ Unbonding Pool │ ────────────────────────────────▶ │ Keeper Wallet  │
│  (Backs Tasks) │   (deducted immediately)  │ (Locked Delay) │         withdraw_stake()          │  (Liquid XLM)  │
└────────────────┘                           └────────────────┘                                   └────────────────┘
```

---

## 5. Dispute Window & Resolution

### 5.1 Dispute Period Mechanics

To enable dispute-based slashing without blocking keeper liquidity forever:
1. **Execution Watermark**: When `execute_task` completes, the task record is
   annotated with `executed_ledger = current_ledger`.
2. **Dispute Window**: For `dispute_window_ledgers` (default: `1,200` ledgers ~ 100
   minutes), the task remains open to disputes.
3. **Reward Holding**:
   - The keeper's earned reward for this specific task remains in a pending
     state (`DataKey::PendingReward(task_id)`), preventing immediate withdrawal
     via `withdraw_rewards` until the window lapses.
   - Once `current_ledger > executed_ledger + dispute_window_ledgers`, the reward
     automatically matures and can be withdrawn.

### 5.2 Dispute Raising and Arbitration

1. **Who can raise a dispute (`raise_dispute`)**:
   - The `Task.owner` who funded the task.
   - A designated protocol `DisputeResolver` or the contract `Admin`.
2. **Dispute Collateral / Bond**:
   - To prevent griefing disputes against honest keepers, raising a dispute
     requires posting a dispute bond (`dispute_bond`).
   - If the dispute is frivolous, the bond is forfeited to the keeper.
3. **State While Dispute is Pending**:
   - The task transitions to `TaskStatus::Disputed`.
   - The keeper's reward for that task remains locked.
   - The keeper cannot unbond stake while an active dispute is pending.
4. **Resolution (`resolve_dispute`)**:
   - Authorized by `Admin` or multi-sig `DisputeResolver`.
   - **Dispute Upheld (Keeper at fault)**:
     - Keeper is slashed for `slash_amount`.
     - Task reward is refunded to task owner.
     - Slashed stake is distributed: restitution to owner + fee to protocol treasury.
     - Dispute bond returned to challenger.
   - **Dispute Dismissed (Keeper honest)**:
     - Task transitions to `Executed`.
     - Keeper reward is released for withdrawal.
     - Challenger's dispute bond is awarded to the keeper for griefing compensation.

---

## 6. Interaction with Existing Mechanics

### 6.1 `claim_task` Eligibility

1. **Configurable Minimum Stake (`min_stake`)**:
   - Admin configures `min_stake` via `set_min_stake(admin, min_stake)`.
   - Default value: `0` (opt-in staking, backward compatible with existing testnets).
2. **Enforcement**:
   - If `min_stake > 0`: `claim_task` queries `keeper_stake(keeper)`. If
     `active_stake < min_stake`, the transaction reverts with
     `KeeperError::InsufficientStake`.
3. **Lock Windows and Execution Parity**:
   - In version 1, all keepers meeting `min_stake` operate under identical
     rules: same `lock_ledgers` duration, same fee structures.
   - Staked keepers do not receive artificial execution priority in the contract
     (preserving the core architectural invariant I-5 of open, fair competition).

---

## 7. Storage Layout, Error Variants, and Interface Signatures

### 7.1 Storage Layout (`DataKey` Additions)

```rust
#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    // Existing keys
    Admin,
    FeeBps,
    Paused,
    TaskCounter,
    RewardToken,
    Task(u64),
    KeeperReward(Address),
    FeesAccrued,
    MinReward,

    // ─── E06 Staking Storage Keys ───
    /// Active stake collateral per keeper.
    KeeperStake(Address),
    /// Pending unbonding records per keeper.
    UnbondingStake(Address),
    /// Global minimum stake floor required to claim tasks.
    MinStake,
    /// Configured unbonding delay in ledgers.
    UnbondingDelay,
    /// Configured dispute window in ledgers following task execution.
    DisputeWindow,
    /// Dispute record for a disputed task.
    TaskDispute(u64),
    /// Pending reward holding record prior to dispute window expiry.
    PendingReward(u64),
}

/// Unbonding record tracking in-flight stake withdrawals.
#[contracttype]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UnbondingRecord {
    pub amount: i128,
    pub unlock_ledger: u32,
}

/// Dispute status and metadata.
#[contracttype]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DisputeRecord {
    pub task_id: u64,
    pub challenger: Address,
    pub keeper: Address,
    pub bond_amount: i128,
    pub created_ledger: u32,
    pub resolved: bool,
}
```

### 7.2 Error Variants (`KeeperError` Additions)

```rust
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum KeeperError {
    // Existing variants 1..27 ...

    // ─── E06 Staking Errors ───
    /// Keeper active stake is below the required minimum stake floor.
    InsufficientStake = 28,
    /// Stake withdrawal requested before the unbonding delay has elapsed.
    UnbondingNotReady = 29,
    /// An unbonding request is already in progress for this keeper.
    UnbondingAlreadyPending = 30,
    /// No unbonding record exists for this keeper.
    NoUnbondingRecord = 31,
    /// Operation disallowed while a task dispute is active.
    DisputePeriodActive = 32,
    /// Dispute does not exist or has already been resolved.
    DisputeNotFound = 33,
    /// Stake deposit or unbond amount must be strictly positive.
    InvalidStakeAmount = 34,
    /// Caller is not authorized to raise or resolve a dispute.
    UnauthorizedDispute = 35,
    /// Task has already passed its dispute window.
    DisputeWindowExpired = 36,
}
```

### 7.3 Entry Point Signatures

```rust
pub trait IKeeperStaking {
    /// Post collateral into active keeper stake.
    fn stake_deposit(env: Env, keeper: Address, amount: i128) -> Result<(), KeeperError>;

    /// Initiate unbonding for an amount of active stake.
    fn initiate_unbond(env: Env, keeper: Address, amount: i128) -> Result<(), KeeperError>;

    /// Withdraw matured unbonded stake back to the keeper's wallet.
    fn withdraw_stake(env: Env, keeper: Address) -> Result<i128, KeeperError>;

    /// Slash a keeper's stake following an authorized dispute or governance action.
    fn slash(
        env: Env,
        admin: Address,
        keeper: Address,
        amount: i128,
        reason: Symbol,
    ) -> Result<(), KeeperError>;

    /// Query the current active stake of a keeper.
    fn keeper_stake(env: Env, keeper: Address) -> i128;

    /// Query any active unbonding record for a keeper.
    fn keeper_unbonding_stake(env: Env, keeper: Address) -> Option<UnbondingRecord>;

    /// Set the minimum stake floor required to claim tasks.
    fn set_min_stake(env: Env, admin: Address, min_stake: i128) -> Result<(), KeeperError>;

    /// Read the minimum stake floor.
    fn get_min_stake(env: Env) -> i128;

    /// Raise a dispute against an executed task within the dispute window.
    fn raise_dispute(env: Env, challenger: Address, task_id: u64, reason: Bytes) -> Result<(), KeeperError>;

    /// Resolve an open dispute.
    fn resolve_dispute(env: Env, admin: Address, task_id: u64, slash_keeper: bool) -> Result<(), KeeperError>;
}
```

### 7.4 Event Topics and Payloads

Following the standard `(verb, noun)` topic convention:

| Event | Topics | Data Payload |
| :--- | :--- | :--- |
| `StakeDeposited` | `("stake", "deposit")` | `(keeper: Address, amount: i128)` |
| `UnbondInitiated` | `("stake", "unbond")` | `(keeper: Address, amount: i128, unlock_ledger: u32)` |
| `StakeWithdrawn` | `("stake", "withdraw")` | `(keeper: Address, amount: i128)` |
| `KeeperSlashed` | `("stake", "slash")` | `(keeper: Address, amount: i128, reason: Symbol)` |
| `DisputeRaised` | `("dispute", "raised")` | `(task_id: u64, keeper: Address, challenger: Address)` |
| `DisputeResolved`| `("dispute", "resolved")`| `(task_id: u64, keeper: Address, slashed: bool)` |

---

## 8. Summary of Decisions

| Architectural Question | Decision | Rationale |
| :--- | :--- | :--- |
| **What counts as slashable?** | Dispute-based in v1 (fraudulent proofs, malicious task squatting, equivocation). | Prevents griefer task owners from weaponizing reverting verifiers against honest keepers. |
| **Dependency on Epic E04?** | No dependency on automatic on-chain verifier slashing. | Post-execution dispute window provides robust economic security without waiting for complex zk/oracle on-chain verifiers. |
| **Where does stake live?** | In-contract storage with isolated `DataKey` entries. | Eliminates cross-contract call gas overhead during high-frequency claims; ensures atomic state consistency. |
| **Unbonding policy?** | Mandatory delay (`unbonding_delay_ledgers`, default ~24h). | Prevents keepers from front-running disputes and draining collateral immediately after fraudulent execution. |
| **Dispute window?** | Bounded challenge period (`dispute_window_ledgers`, default ~100 min) with held rewards. | Provides task owners sufficient time to challenge bad proofs before rewards leave contract escrow. |
| **Claiming interaction?** | Configurable `min_stake` floor (default 0). | Backwards-compatible; when set, prevents uncollateralized bots from hoarding task claims. |

---

## 9. Implementation Roadmap (Epics 0289–0316)

1. **0289**: Stake storage and the `stake_deposit` entry point (`KeeperStake` storage key, event, tests).
2. **0290**: Unbonding delay implementation (`initiate_unbond`, `withdraw_stake`, ledger boundary tests).
3. **0291**: Slash entry point and authorization model (penalty routing to treasury/owner).
4. **0292**: Minimum stake requirement in `claim_task`.
5. **0293**: Dispute window between execution and reward finality (`PendingReward`, dispute flow).
6. **0294–0316**: Solvency property tests, storage TTL extensions, indexer schema, and SDK bindings.
# Staking and Slashing Design (E06) — Retrospective and Stable Surface

This document closes epic E06 by recording the contract surface that was actually settled, what was intentionally left out, and what future work can safely build on without re-litigating design questions already answered.

## Status

The staking work is intentionally narrow and conservative:

- keeper collateral is tracked in the registry itself;
- stake is a per-keeper balance with an explicit unbonding delay;
- the minimum stake floor is an admin-configurable threshold checked at claim time;
- slash authority is explicit and contract-enforced;
- batch slash is not part of the shipped surface.

This is the stable layer the reputation and governance epics can rely on.

## 1. Original design questions from issue 0288

Issue 0288 framed five open design questions:

1. What counts as slashable?
2. Where stake lives: same contract vs. dedicated staking contract?
3. Whether withdrawal is immediate or delayed.
4. Whether a dispute window exists and who can challenge.
5. Whether staking changes claim priority or execution semantics.

The E06 implementation accepted a deliberately limited answer to each of these.

## 2. Divergences from the original design

The following differences are intentional and should be treated as the canonical design, not as accidental omissions.

### 2.1 Same-contract staking, not a dedicated staking contract

The design keeps stake in the keeper registry rather than introducing a separate staking contract that the registry calls into.

This was chosen because the registry already owns the keeper lifecycle, task escrow, and reward accounting. Keeping stake in the same contract avoids a cross-contract call on every claim or slash check and makes the collateral state easier to reason about in one ledger.

The tradeoff is explicit: future work may introduce a separate staking wrapper, but the registry's internal storage and event model remain the stable source of truth for account balances and enforcement.

### 2.2 No automatic, verifier-driven slashing in the first shipped surface

Issue 0288 left open whether slashing should be automatic, dispute-based, or admin-triggered. The shipped surface does not add an on-chain dispute engine or an automatic verifier-derived slash trigger.

Instead, the contract exposes a single, explicit slash authority and enforces that only that authority may reduce a keeper's active stake. This keeps the security model contained and avoids coupling slashability to a verifier or governance subsystem that is not part of the registry core.

### 2.3 No claim-priority or reputation-based staking effect in the core registry

The original design considered whether a keeper with more stake gets different treatment in `claim_task` or `execute_task` than one with no stake.

The shipped design keeps staking as a collateral floor and accountability mechanism, not as a claim-priority or execution-boost mechanism. A keeper's stake can affect eligibility only through a configurable minimum floor; it does not alter the ordering of claim competition or the reward flow.

This keeps the core task registry simple and prevents a subtle incentive bug where a keeper could game the queue by over-staking rather than by performing work correctly.

### 2.4 No dispute window state machine in core staking

The design document considered a challenge period and a pending-dispute state. That functionality was not added to the registry.

The stable surface therefore treats slashing as a direct action by the slash authority, with event history as the audit record. If a future dispute or appeal system is added, it must be layered on top of this ledger state rather than being embedded in the core staking primitive.

### 2.5 No batch slash API

The design intentionally keeps the slash surface single-target. The threat model for a systemic incident is handled operationally by repeated single-target slashes, not by a batch entry point that can slash many keepers in one transaction.

## 3. Deferred and explicitly declined work

This section records the decisions that were not silently dropped.

### 3.1 Batch slashing was explicitly declined

Issue 0308 evaluated whether `batch_slash` was worth building for a systemic incident. The recommendation is to decline it.

Reasoning:

- a single admin call that can slash many keepers has a much larger blast radius than a single targeted slash;
- the operational complexity is higher than the benefit in the rare events this would matter;
- repeated single slashes remain a reasonable operational cost for an incident response that must remain auditable and narrow in scope.

This is therefore not a latent feature gap. It is an explicit product decision: batching slash is not part of the stable interface.

### 3.2 Dispute and appeal logic remains future work

The first staking design does not include a challenge or appeal system. This is intentionally deferred. Any future E07/E09 work that needs a richer accountability model can add it on top of the keeper stake record without needing to rewrite the registry's balance accounting.

### 3.3 Reputation and governance are downstream consumers, not embedded in staking core

The staking ledger is defined as an audit-friendly base layer. Reputation and governance work should consume the staking history as input rather than re-implementing stake logic in their own contracts.

## 4. Stable surface for E07 and E09

The following contract surface is the durability boundary future epics can build against.

### 4.1 Ledger state

The stable ledger model is:

- `Stake(Address) -> i128`: active staked balance for a keeper.
- `PendingUnbond(Address) -> PendingUnbond`: the amount currently in an unbonding state and the associated release condition.
- `MinStake -> i128`: configurable minimum active stake for a keeper to claim tasks.
- `UnbondingDelay -> u64`: configured number of ledgers a pending unbond must age before it becomes withdrawable.
- `SlashAuthority -> Address`: the explicit authority allowed to slash.

The important invariant is that active stake and pending unbonding are distinct states. A keeper cannot satisfy the minimum-stake check using collateral that is already committed to an unbonding withdrawal.

### 4.2 Core entries

The stable staking entry points are:

- `deposit_stake(keeper, amount)`
- `initiate_unbond(keeper, amount)`
- `withdraw_stake(keeper)`
- `slash(keeper, amount, reason)`

These are the primitive actions on which future work can build. They are concrete and narrow enough to be stable for indexers, dashboards, and reputation logic.

### 4.3 Views and config surfaces

The stable read-only surface is:

- `stake(keeper) -> i128`
- `pending_unbond(keeper) -> PendingUnbond`
- `min_stake() -> i128`
- `unbonding_delay() -> u64`
- `slash_authority() -> Address`

These values are part of the long-lived data model and are safe for E07 and E09 to read directly. Any future reputation or governance logic should consume these values rather than inferring state from unrelated task activity or external off-chain metadata.

### 4.4 Events as the audit trail

The event stream is the canonical record for indexers and future consumer epics. Specifically, the staking ledger must carry enough information to reconstruct:

- deposit history;
- pending unbonding and release timing;
- successful withdrawals;
- slash events and reasons.

This is the layer E07 and E09 should attach to: stake history, collateral health, and slash evidence, not bespoke ad-hoc queries against scattered storage keys.

## 5. Final design boundary

The E06 design is intentionally not a full governance, dispute, or reputation system. It is a stable staking primitive on which future epics can build.

The contract will:

- hold and enforce the keeper's stake,
- delay withdrawal for a configurable unbonding period,
- enforce a configured minimum active stake where needed,
- allow only the designated slash authority to reduce stake,
- expose a clean event stream for downstream reputation and governance work.

It will not:

- implement a batch slash API,
- add a dispute or appeal state machine,
- change claim priority on the basis of stake,
- embed future governance or reputation policy into the registry's core accounting.

That is the stable surface on which E07 and E09 can build with confidence.
