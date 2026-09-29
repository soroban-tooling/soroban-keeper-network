# Treasury Design Retrospective

## Epic E08 Retrospective
This document records what was built against issue 0338's original design, any divergence, and the stable surface epic E09's governance work can build on if governance is meant to control treasury parameters (recipient shares, in particular) once it exists.

## Divergences from Original Design
There were no significant divergences from the original design. The implemented parameters and distribution rules strictly followed the initial scaffolding and acceptance criteria laid out in E08.

## Stable Surface for Governance (Epic E09)
The following treasury parameters are currently admin-controlled and are stable candidates for governance control:
- Recipient shares: Configuration of how the swept fees are split among recipients.
- Pause mechanism: The ability to pause the treasury contract in emergencies.
- Upgrade path: The ability to upgrade the treasury contract's Wasm.

## Deferred Questions
- The exact governance mechanism (e.g., Soroban governor vs. simple multisig) is deferred to E09.
- The precise list of initial recipients and their exact basis point shares are deferred until launch governance parameters are finalized.
# Treasury Design (Epic E08, issue #466 / 0338)

## Status

Decided and implemented in `contracts/treasury` (issue #468 / 0340). The
registry-side boundary is pinned in `sweep_fees`'s comment in
`contracts/keeper-registry/src/admin.rs` (issue #469 / 0341). This
document is the reference later E08 issues build on: recipient management
(0342), events (0343), the reentrancy review (0344), views (0346), SDKs and
the indexer (0347-0349), and upgrade and pause (0350-0351).

## 1. Context

Today the registry adds every execution's protocol fee to one
`FeesAccrued` accumulator. The admin moves it out with
`sweep_fees(admin, treasury, amount)`: a single token transfer to any
address the admin names, bounded by `FeesAccrued` so it can never touch
task escrow or keeper balances (invariant I-1, `docs/ARCHITECTURE.md`).

That works for one recipient. Splitting revenue between several
stakeholders (a DAO treasury, a staking-rewards pool, a public-goods fund)
would mean a manual, trusted admin step for every distribution. This epic
replaces that step with a fixed, auditable rule.

## 2. Decision: a separate treasury contract

**Chosen: a separate `keeper-treasury` contract that the registry sweeps
into.** Rejected: named recipients and routing rules inside the registry.

| | Separate contract (chosen) | In-registry routing |
|---|---|---|
| Blast radius of a distribution bug | Limited to swept fees already held by the treasury. Task escrow and keeper balances are in a different contract. | Same contract and token balance as all task escrow. A bug in split or recipient logic sits next to I-1. |
| Registry changes | None to logic or ABI (see §3). | New storage keys, admin entry points, events, an error range and a `VERSION` bump, plus a larger audit surface in the most value-dense contract. |
| Cost per sweep | `sweep_fees` is still one token transfer. `distribute` is a separate call, at most `MAX_RECIPIENTS` storage writes. | One call, but `sweep_fees` gains a loop and a storage write per recipient. |
| Upgrade independence | Distribution rules can change, or the treasury can be replaced, without touching the registry. The admin just sweeps to a new address. | Any change to distribution means upgrading the registry. |
| Extra cross-contract call | None added. The token transfer to the treasury address already happens today. | None. |

The usual argument for in-registry routing is that it saves a
cross-contract call on every sweep. Under the automation decision in §4,
that call never exists: the registry does not call the treasury at all.
The separate contract therefore costs nothing extra per sweep and keeps
distribution bugs out of the escrow contract, so it is the clear choice.

## 3. Registry boundary (`sweep_fees`)

`sweep_fees` is **unchanged**, in both signature and behavior. To route
fees through the treasury, the admin passes the treasury contract's
address as `treasury`. The registry does not store a treasury address and
makes no call into the treasury contract.

Two alternatives were considered and rejected:

- **A registry-stored treasury address** (a `set_treasury` entry point,
  with `sweep_fees` dropping its `treasury` argument). This would stop the
  admin from sweeping to an arbitrary address. But the same admin can
  change the stored address, or `upgrade` the registry, so it adds no
  protection against the admin. It would also break the ABI for the SDKs,
  the indexer and the keeper bots.
- **`sweep_fees` calling `treasury.distribute` itself.** This couples the
  registry's fee exit to the treasury's liveness: a paused, misconfigured
  or buggy treasury would make `sweep_fees` fail. It also adds a callback
  into an external contract on a path that holds escrow. Keeping the two
  steps separate means a treasury fault can at worst leave swept fees
  sitting undistributed in the treasury.

I-1 is unaffected. `sweep_fees` still moves only `FeesAccrued`. The round
trip test `test_sweep_fees_round_trip_through_treasury_distribution`
(`contracts/keeper-registry/src/test/withdraw.rs`) checks that after the
sweep the registry holds exactly open escrow plus keeper balances.

## 4. Automation

Two separate steps:

1. **Sweep: manual and admin-only, as today.** `sweep_fees` is the
   registry's only way to release fees, and deciding when (and how much)
   revenue leaves the registry stays an admin decision.
2. **Distribute: permissionless.** Anyone may call
   `distribute(amount)` for up to `undistributed()`, the treasury's token
   balance minus what it already owes recipients. A keeper bot, a
   recipient, or the admin straight after a sweep can trigger it.

Why distribution is permissionless: the admin sets the split in advance
(§5), so the caller chooses only **when** funds are split, never **where**
they go. Requiring the admin to sign each distribution would bring back
the per-distribution trust step this epic exists to remove.

Scheduled or threshold-triggered distribution was rejected. Soroban has no
on-chain scheduler, so a "schedule" would still need someone to submit a
transaction, and a permissionless `distribute` already lets anyone do that
whenever they choose.

The only discretion left to the caller is the size of each `distribute`,
which decides how often rounding happens. Per §5, each call moves under
`MAX_RECIPIENTS - 1` stroops (fewer than 9) of rounding remainder to
the primary recipient. Stellar's minimum base fee is 100 stroops per
operation, so repeatedly calling `distribute` with small amounts to push
remainder toward the primary always costs more than it moves.

## 5. Distribution rule

**Fixed basis-point shares to fixed addresses, configured as a whole set.**

- 1 to `MAX_RECIPIENTS` (10) recipients, each with `shares_bps` in
  `1..=10_000`, all distinct, summing to **exactly** `TOTAL_SHARES_BPS`
  (10,000).
- A set that breaks any rule is rejected by `set_recipients` with a typed
  error (`NoRecipients`, `TooManyRecipients`, `InvalidShare`,
  `DuplicateRecipient`, `SharesDoNotSumToTotal`), and the previous set
  stays in force. A set is never normalized.
- Because the sum must be exact, single-recipient add, remove or reweight
  calls cannot each keep the set valid. So the configuration entry point
  replaces the whole set atomically. Backlog 0342 (add, remove and
  reweight) should be built as wrappers that construct the full resulting
  set and go through the same validation, rather than relaxing the
  exact-sum rule.

**Rounding.** `split_amount` gives every recipient except the first
`floor(amount * shares_bps / 10_000)`. The first recipient, the
**primary**, gets `amount` minus those parts. The parts sum to exactly
`amount`, every part is non-negative, no non-primary recipient gets more
than its nominal share, and the primary receives the discarded fractions,
fewer than `n - 1` stroops. This mirrors the registry's `split_reward`,
where the keeper takes the floor-division remainder. The admin chooses
the primary by putting it first in the set, normally the DAO treasury.
All arithmetic is checked `i128`, with no floating point. An overflow
returns `ArithmeticOverflow` rather than panicking.

**Stake-weighted distribution was rejected for this epic.** E06 staking
exists, but weighting protocol revenue by keeper stake is a keeper-rewards
design, not a treasury one: it would need a live cross-contract read of
every staker, which is unbounded. A staking-rewards pool can instead be a
single recipient address, with its own contract dividing its share among
stakers.

**Mid-flight reconfiguration.**

- Credited balances are keyed by address and never recalculated. A
  recipient dropped from the set keeps its balance and can still
  `withdraw` it.
- Funds received but not yet distributed are split by whichever set is
  active when `distribute` runs. An admin who wants the old split applied
  to them calls `distribute` before `set_recipients`. Both steps are
  public and emit events, so the ordering is auditable.

## 6. Custody model: pull, not push

`distribute` credits each recipient's internal balance, and each recipient
calls `withdraw` to receive its tokens. `distribute` makes no outbound
transfer. Its only external call is a read of the treasury's own token
balance.

- **A recipient cannot block the others.** Under a push model, one
  recipient that cannot receive tokens (for example a revoked SAC
  authorization or a missing trustline) would make the whole distribution
  fail.
- **Minimal reentrancy surface** (this is what backlog 0344 reviews).
  `distribute` never hands control to a recipient. `withdraw`
  follows checks-effects-interactions: it zeroes the balance and reduces
  `TotalOwed` before transferring, as the registry's `withdraw_rewards`
  does.

**Solvency invariant T-1:** `token.balance(treasury) >= TotalOwed`.
`distribute` only credits `amount <= balance - TotalOwed`, and `withdraw`
reduces `TotalOwed` by exactly what it transfers. Tokens sent to the
treasury by anyone, including `sweep_fees`, are undistributed until
`distribute` assigns them. If a token clawback ever pushed the balance
below `TotalOwed`, `undistributed()` reads 0 and `distribute` refuses to
run.

## 7. Auditability

**Mainly event-driven, with on-chain totals to check the replay against.**

Revenue can be fully reconstructed from events: `("sweep", "admin")` on the
registry (already ingested by the E14 indexer), then treasury
`("dist", "total")` with the per-recipient breakdown, then
`("wdraw", "recip")`. The configuration history comes from
`("set", "recip")`, which carries the whole set each time, so there is
nothing to replay incrementally.

The contract keeps only the accounting needed for solvency and a
reconciliation check: `TotalOwed`, the lifetime `TotalDistributed`, and
per-recipient balances. It stores no distribution history. A treasury
report is built by replaying events and checked against the views:

- `total_distributed()` equals the sum of every `("dist", "total")` amount.
- `recipient_balance(r)` equals `r`'s credited parts minus its withdrawals.
- `undistributed()` equals the fees swept to this address, plus any direct
  transfers, minus `total_distributed()`.

Per-distribution history on-chain was rejected: it grows without bound and
duplicates the event log, which is the audit trail everywhere else in this
project.

## 8. Pinned surface

### Storage keys

| Key | Storage | Type | Default when unset |
|-----|---------|------|--------------------|
| `DataKey::Admin` | Instance | `Address` | unset until `initialize` |
| `DataKey::Token` | Instance | `Address` | unset until `initialize` |
| `DataKey::Recipients` | Instance | `Vec<Recipient>` (at most 10) | unset until the first `set_recipients` |
| `DataKey::TotalOwed` | Instance | `i128` | `0` |
| `DataKey::TotalDistributed` | Instance | `i128` | `0` |
| `DataKey::Balance(Address)` | Persistent (TTL renewed on write, 100,000 ledgers) | `i128` | `0` |

`Recipient { address: Address, shares_bps: u32 }`.

### Entry points

| Signature | Auth | Notes |
|-----------|------|-------|
| `initialize(admin: Address, token: Address) -> Result<(), TreasuryError>` | `admin` | Once only. `token` must be the registry's reward token. |
| `set_recipients(admin: Address, recipients: Vec<Recipient>) -> Result<(), TreasuryError>` | admin | Atomic whole-set replacement (§5). |
| `distribute(amount: i128) -> Result<(), TreasuryError>` | none | Permissionless (§4). |
| `withdraw(recipient: Address) -> Result<i128, TreasuryError>` | `recipient` | Pull model, CEI (§6). |
| `transfer_admin(admin: Address, new_admin: Address) -> Result<(), TreasuryError>` | both | Same two-party handover as the registry. |
| `version() -> u32` | none | `VERSION = 1`. |
| `recipients() -> Vec<Recipient>` | none | Empty before configuration. |
| `recipient_balance(recipient: Address) -> i128` | none | |
| `undistributed() -> Result<i128, TreasuryError>` | none | Balance minus `TotalOwed`, never negative. |
| `total_distributed() -> i128` | none | |

Views have no side effects and never renew TTL, per the registry's
`views.rs` policy.

### Events

| Topic | Data |
|-------|------|
| `("init", "treasury")` | `(admin, token)` |
| `("set", "recip")` | `Vec<Recipient>`, the complete new set |
| `("dist", "total")` | `(amount: i128, breakdown: Vec<(Address, i128)>)`, in set order, summing to `amount` |
| `("wdraw", "recip")` | `(recipient, amount)` |
| `("xfer", "admin")` | `(old_admin, new_admin)` |

### Errors (`TreasuryError`)

`AlreadyInitialized = 1`, `NotInitialized = 2`, `Unauthorized = 3`,
`NoRecipients = 4`, `TooManyRecipients = 5`, `InvalidShare = 6`,
`SharesDoNotSumToTotal = 7`, `DuplicateRecipient = 8`, `InvalidAmount = 9`,
`InsufficientUndistributed = 10`, `NoBalance = 11`,
`ArithmeticOverflow = 12`. These numbers are ABI and must never be
renumbered.

## 9. Non-goals for this epic's first cut

Left to their own backlog items: pause (0351), upgrade (0350), per-
recipient add/remove/reweight wrappers (0342), SDK methods (0347-0348),
indexer ingestion of treasury events (0349), a fuzz target (0352), and the
closing security review (0358). None of them requires changing the storage
keys or signatures pinned above. Each only adds to them.
