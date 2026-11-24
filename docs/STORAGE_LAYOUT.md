# Storage Layout Survey (issue 0105)

This is a survey, not a change. It answers the three questions issue 0105
raised about the `Task` struct's storage cost, grounded in Soroban's actual
storage/resource model rather than assumption. No contract code changes are
made by this document.

## Background: what Soroban actually charges for

Two mechanics matter here:

- **Per-entry overhead.** Every distinct storage key touched by a call is
  charged its own read/write resource cost and counts separately against the
  transaction's footprint (Soroban caps how many distinct ledger entries one
  transaction may read/write). Splitting one logical record across two keys
  means any call that needs both pays for two entries, not one.
- **Per-byte cost.** Within an entry, `set`/`get` cost scales with the
  XDR-serialized size of the *whole* value — Soroban has no field-level
  storage; `e.storage().persistent().set(&key, &task)` re-serializes and
  writes every field of `Task`, whether or not the call that triggered the
  write actually touched that field.

So the lever this repo has is: which fields get re-serialized on writes they
don't need, and does the field count justify a second entry's fixed overhead.

## Current persisted `Task` record (contract VERSION 6)

`DataKey::Task(task_id)` stores one `Task` value with the following fields:

| Field | Type | Registration default / source |
|---|---|---|
| `owner` | `Address` | Authorized task registrant |
| `task_type` | `TaskType` | Caller-supplied task category |
| `calldata` | `Bytes` | Caller-supplied, bounded payload |
| `reward` | `i128` | Positive escrow amount |
| `deadline` | `u64` | Caller-supplied Unix timestamp |
| `ttl_ledgers` | `u32` | Caller-supplied bounded TTL |
| `status` | `TaskStatus` | `Pending` |
| `claimer` | `Option<Address>` | `None` |
| `claim_ledger` | `Option<u32>` | `None` |
| `lock_ledgers` | `u32` | Caller-supplied bounded lock window |
| `verifier` | `Option<Address>` | Caller-supplied; `None` skips proof verification |
| `condition` | `Option<Address>` | Caller-supplied; `None` preserves unconditional claiming |

### Condition-field schema evolution

Adding `condition` to the `#[contracttype]` struct is not a backward-compatible
storage decode. A VERSION 6 contract cannot deserialize the old eleven-field
record as the new twelve-field `Task`; `None` is the registration default, not
an implicit value injected while decoding old XDR. The regression test
[`pre_condition_task_encoding_requires_explicit_migration`](../contracts/keeper-registry/src/test/condition.rs)
serializes the exact pre-condition shape and proves that decoding it as the new
shape fails.

Deployments with existing task records must therefore use an explicit migration
that writes `condition: None`, or deploy a replacement registry and keep old
sessions routed to their original contract. The VERSION 6 bump is the public
compatibility signal; an in-place WASM update alone is not a migration.

## Q1 — Is `claim_ledger` (or any field) redundant?

**No.** `claim_ledger` is read every time `lock_expired` is evaluated
(`contracts/keeper-registry/src/lib.rs`, `lock_expired`), and that happens on
every subsequent `claim_task` or `cancel_task` call against an already-claimed
task — not just once. A second keeper attempting to re-claim (or the owner
attempting to cancel) five ledgers after the first claim needs the exact same
`claim_ledger` value that the first claim wrote; it cannot be "evaluated once
and dropped."

Recomputing it from an event log is not an option at all, independent of
cost: **Soroban contracts cannot read their own past emitted events** — events
are a one-way channel to off-chain consumers (indexers, keeper bots), not a
queryable log the contract can call back into. The only way `lock_expired` can
compare "now" against "when this task was claimed" is if `claim_ledger` is
itself in storage. Same reasoning applies to every other field on `Task` —
each is read by at least one function on a repeat basis (`status` and
`claimer` by every lifecycle transition, `reward`/`deadline` by execution and
expiry, `ttl_ledgers`/`lock_ledgers` by `save_task`'s `extend_ttl` and
`lock_expired` respectively). No field is dead weight.

**Conclusion: no redundant fields to remove.**

## Q2 — Would a hot/cold split reduce typical read/write cost?

**Yes, for the write side — this is the one worth acting on.**

`save_task` (`contracts/keeper-registry/src/lib.rs:375`) unconditionally
re-writes the *entire* `Task` struct, including `calldata` (up to
`MAX_CALLDATA_LEN` = 1024 bytes) and `task_type`, on every lifecycle
mutation. Checking each caller of `save_task`:

| Function | Reads `calldata`/`task_type`? | Writes them (via full-struct `save_task`)? |
|----------|:---:|:---:|
| `register_task` | writes them (registration) | yes — this is the one call that should |
| `increase_reward` | no | yes — unnecessarily |
| `extend_deadline` | no | yes — unnecessarily |
| `claim_task` | no | yes — unnecessarily |
| `execute_task` | no | yes — unnecessarily |
| `cancel_task` | no | yes — unnecessarily |
| `expire_task` | no | yes — unnecessarily |

Every mutation *after* registration pays to re-serialize and write bytes it
never reads or changes. `claim_task` and `execute_task` are, per issue 0107,
the two entry points most likely to be called under real load — so this is
exactly the "typical" call the question asks about, not an edge case.

A hot/cold split (`TaskHot(id)`: `owner`, `reward`, `deadline`, `ttl_ledgers`,
`status`, `claimer`, `claim_ledger`, `lock_ledgers` — everything read or
written after registration; `TaskCold(id)`: `task_type`, `calldata` — written
once, read only by whatever reconstructs the target call off-chain from the
`calldata` bytes, which is never the contract itself) would let
`claim_task`/`execute_task`/`cancel_task`/`expire_task`/`increase_reward`/
`extend_deadline` touch only `TaskHot`, skipping calldata's byte cost
entirely on the calls that dominate real traffic.

The cost this trades away: `register_task` now writes two entries instead of
one (a second fixed per-entry overhead, paid once per task), and any read
path that needs the full record for backward-compatible output (e.g.
`get_task`, if it is to keep returning today's shape) now reads two entries
instead of one. Given `claim_task`/`execute_task` are called at least as
often as `register_task` (every task is registered once but claimed and
executed each exactly once too, and re-claimed an unbounded number of times
when a keeper's lock expires), the write-side savings on the hot path
plausibly outweigh the one-time extra write and the view-side extra read —
but this is a big enough behavioral and storage-shape change that it belongs
in its own scoped issue with migration analysis, not decided here.

**Conclusion: worthwhile enough to file a follow-up issue** — see
[0204-task-storage-hot-cold-split.md](../.github/backlog/issues/0204-task-storage-hot-cold-split.md).

## Q3 — Where should the E04 verifier field live, once it exists?

This repo has not yet implemented the verifier field (`docs/VERIFIER_DESIGN.md`
is a proposed design; `Task` has no `verifier` field today). Answering
for when it lands:

**A separate `DataKey::TaskVerifier(task_id)` entry, not a field on `Task`,
is cheaper for the common case.** The verifier is explicitly optional
(`VERIFIER_DESIGN.md` §1: "per-task, on-chain verification callback"); most
tasks are expected to have none. Putting `verifier: Option<Address>` directly
on `Task` charges every single task — including the ones with no verifier —
the byte cost of an `Option` tag (and, if this repo later stores a version
count or trust-list channel with `Address`, encoding a `None` variant is not
free in Soroban's XDR encoding) on every one of the same six lifecycle writes
identified in Q2, forever, regardless of whether that task ever uses the
feature. A separate entry is read only by `execute_task`, and only exists at
all for the tasks that actually register one — the majority of tasks that
never attach a verifier never pay for it.

The tradeoff: `register_task` gains a second conditional write (only when a
verifier is supplied) and `execute_task` gains a conditional extra read
(`get` returning `None` if absent) — but that extra read only lands on the
call that actually needs the answer, which is the entire point of making the
field optional in the first place.

**Conclusion: recommend `DataKey::TaskVerifier(task_id)` as a separate entry
when E04's verifier field is implemented** — no code changes go out from
this document; the recommendation is captured here for whoever picks up the
verifier-field implementation issue (0072) to weigh against a plain `Task`
field.

## Summary

| Question | Finding | Action |
|----------|---------|--------|
| Q1 — redundant fields | None — every field is re-read on a recurring path, and events can't substitute for storage | No action |
| Q2 — hot/cold split | Real, measurable win on the write side for the two hottest entry points | Follow-up issue filed: [0204](../.github/backlog/issues/0204-task-storage-hot-cold-split.md) |
| Q3 — verifier field placement | Separate `DataKey::TaskVerifier(task_id)` is cheaper than a `Task` field for the common no-verifier case | Recorded here for issue 0072 to apply when implemented |

---

# Key / TTL matrix (issue #739)

The survey above is about the *cost* of one record. This section answers the
security question: **can two storage keys collide, and does every entry have a
TTL policy?** It is exhaustive over both contracts' `DataKey` enums, plus the
separate `ReputationKey` enum the registry keeps in the same storage.

`contracts/keeper-registry/src/test/storage_layout.rs` mechanically checks
that every variant below has a row and that all keys of one contract encode to
distinct XDR byte strings. `include_str!` feeds the source into the test, so a
new variant fails `cargo test` until it is documented here.

## Collision analysis

Soroban's `#[contracttype]` derives XDR `ScVal` encodings: an enum is a
tagged union whose **variant discriminant is part of the encoded bytes**, and
each payload is encoded after it. Within one contract's storage:

- `Task(1)` and `Slash(1)` carry the same `u64` payload but different variant
  discriminants, so they are different keys.
- `KeeperReward(addr)` and `KeeperStake(addr)` carry the same `Address`
  payload but different discriminants, so they are different keys.
- A unit variant (`Admin`) cannot equal a tuple variant (`Task(u64)`).
- `ReputationKey::Keeper(addr)` lives in a *different enum type* but is stored
  in the same registry contract. Its own discriminant namespace is disjoint
  from `DataKey`'s, and the XDR-encoding test below proves the concrete keys
  are distinct.

The two contracts' enums both have an `Admin` variant that would encode
identically, but contract storage is namespaced by contract address: a key in
the treasury can never address a cell in the registry. Same encoded bytes in
two different contracts is not a collision.

**Conclusion: no two variants that share a storage namespace can collide.**
The test proves it for every variant, not just the examples above.

## TTL model

There are exactly two storage classes in use. **No production code calls
`e.storage().temporary()`** — a source-scan test enforces that. Everything is
either:

- **Instance storage:** one shared TTL for all keys of a contract, renewed by
  `bump_instance()` (threshold 50,000, extend-to 100,000 ledgers) from every
  state-mutating entry point and never from read-only views. There are no
  per-key TTLs to list here.
- **Persistent storage:** each key has its own TTL, extended on the write path
  named below. An entry whose TTL reaches zero is *archived*: the host refuses
  to let the contract read or write it until an explicit `RestoreFootprint`
  operation restores it. The contracts never restore anything, so from the
  application's point of view an archived entry is **permanently inaccessible**.

<!-- BEGIN REGISTRY KEY MATRIX -->
## Registry keys (`contracts/keeper-registry/src/types.rs`, `reputation.rs`)

| Key | Storage | Value | Written by | TTL policy | Expiry consequence |
| --- | --- | --- | --- | --- | --- |
| `Admin` | instance | `Address` | `initialize`, `transfer_admin` | shared instance TTL, bumped on every mutation | no config updates possible until restored; escrow still held by the contract |
| `FeeBps` | instance | `u32` | `initialize`, `set_fee_bps` | shared instance TTL | fee reads fall back to `DEFAULT_FEE_BPS` only if the key is missing, not if the instance is archived — the whole instance is inaccessible |
| `Paused` | instance | `bool` | `initialize`, `pause`, `unpause` | shared instance TTL | pause state unreadable; the contract is unusable |
| `TaskCounter` | instance | `u64` | `initialize`, `next_task_id` | shared instance TTL | no new tasks could be registered even if escrow remained |
| `RewardToken` | instance | `Address` | `initialize` | shared instance TTL | every token-moving path fails |
| `Task(u64)` | persistent | `Task` | `save_task` from register/batch/increase/extend/claim/execute/cancel/expire | `extend_ttl(task.ttl_ledgers, task.ttl_ledgers)` on **every** write; registration enforces `ttl_ledgers >= MIN_TTL_LEDGERS` and `>= required_ttl_ledgers(deadline)` (deadline covered plus `TTL_SAFETY_MARGIN_LEDGERS` = 17,280) | **FUNDS LOST** — the owner/amount needed by `cancel_task`/`expire_task` is gone, so escrow cannot be refunded |
| `KeeperReward(Address)` | persistent | `i128` | `credit_keeper` (execute/finalize), zeroed by `withdraw_rewards` | 50,000 / 100,000 on credit; withdrawal zeroes without extending (a zeroed entry has nothing to protect) | **FUNDS LOST** — earned rewards inaccessible; tested below |
| `FeesAccrued` | instance | `i128` | `accrue_fee`, `sweep_fees` | shared instance TTL | protocol fees stranded in the contract |
| `MinReward` | instance | `i128` | `set_min_reward` | shared instance TTL | floor silently disappears, not a direct fund loss |
| `KeeperStake(Address)` | persistent | `i128` | `stake_deposit`, `initiate_unbond`, `slash`, `resolve_slash_appeal` | `KEEPER_STAKE_BUMP_THRESHOLD` 50,000 / `KEEPER_STAKE_BUMP_LEDGERS` 100,000 on every write | **FUNDS LOST** — bonded stake cannot be checked or unbonded |
| `UnbondRequest(Address)` | persistent | `UnbondRequest` | `initiate_unbond`, partial `slash`; removed by `withdraw_stake` | 50,000 / 100,000 on every write | **FUNDS LOST** — pending withdrawal amount cannot be claimed |
| `MinStake` | instance | `i128` | `set_min_stake` | shared instance TTL | gate silently disappears, not a direct fund loss |
| `SlashCounter` | instance | `u64` | `next_slash_id` | shared instance TTL | new slash ids could repeat after a restore |
| `Slash(u64)` | persistent | `SlashRecord` | `slash`, `raise_slash_appeal`; removed by `resolve_slash_appeal` | 50,000 / 100,000 on both writes (`raise_slash_appeal` renews explicitly — see `docs/STAKING_SECURITY_REVIEW.md`) | **FUNDS LOST to the keeper** — an appeal can no longer be raised or resolved, so the slashed amount stays with the treasury |
| `DisputeWindowLedgers` | instance | `u32` | `set_dispute_window` | shared instance TTL | hold duration silently reads as 0, not a direct fund loss |
| `PendingReward(Address)` | persistent | `Vec<PendingCredit>` | `add_pending_credit`, `finalize_rewards`, `dispute_execution`, `resolve_execution_dispute`; removed when empty | 50,000 / 100,000 via the single `save_pending_credits` helper on every write | **FUNDS LOST** — undisputed credits can no longer finalize or be withdrawn |
| `SlashHistory(Address)` | persistent | `SlashHistory` | `write_slash_history` | `KEEPER_STAKE_BUMP_THRESHOLD` 50,000 / 100,000 | informational only — no direct fund loss |
| `ReputationFloor` | instance | `u32` | `set_reputation_floor` | shared instance TTL | floor silently reads as 0, not a direct fund loss |
| `ReputationKey::Keeper(Address)` | persistent | `ReputationRecord` | `reputation::update` (success / missed claim) | `REPUTATION_TTL_THRESHOLD` 50,000 / `REPUTATION_TTL_LEDGERS` 6,300,000 on every write | informational only — score resets to zero, no direct fund loss, but a keeper above an admin-set floor loses eligibility |
<!-- END REGISTRY KEY MATRIX -->

<!-- BEGIN TREASURY KEY MATRIX -->
## Treasury keys (`contracts/treasury/src/types.rs`)

| Key | Storage | Value | Written by | TTL policy | Expiry consequence |
| --- | --- | --- | --- | --- | --- |
| `Admin` | instance | `Address` | `initialize`, `transfer_admin` | shared instance TTL (50,000 / 100,000 on every mutation) | no admin action possible |
| `Paused` | instance | `bool` | `initialize`, `pause`, `unpause` | shared instance TTL | pause state unreadable; contract unusable |
| `RewardToken` | instance | `Address` | `initialize` | shared instance TTL | no transfer possible |
| `RecipientList` | instance | `Vec<Address>` | `add_recipient`, `remove_recipient` | shared instance TTL | recipients can no longer be enumerated |
| `TotalDistributed` | instance | `i128` | `accrue_total_distributed` | shared instance TTL | indexer reconciliation figure lost; no direct fund loss |
| `RecipientShares(Address)` | persistent | `u32` | `set_recipient_shares` (add/update/remove) | 50,000 / 100,000 on every write via the single helper | no further distributions to that recipient; already-credited balances unaffected |
| `RecipientBalance(Address)` | persistent | `i128` | `credit_recipient` (distribute), zeroed by `withdraw` | 50,000 / 100,000 on credit; withdrawal zeroes without extending | **FUNDS LOST** — credited balance cannot be withdrawn |
| `RecipientReceivedTotal(Address)` | persistent | `i128` | `credit_recipient` | 50,000 / 100,000 on every write | informational only — no direct fund loss |
<!-- END TREASURY KEY MATRIX -->

## Expiry-loses-funds entries, behaviourally verified

`test/storage_layout.rs` proves the archival consequence rather than merely
asserting it in prose. Each test raises the host's `max_entry_ttl` cap and
extends *only the registry instance* with a test util, then advances past the
target key's own TTL. That isolates the entry under test: the failure is an
archived `DataKey::…`, not an archived contract instance.
`#[should_panic(expected = "archived")]` is the Soroban test host's way of
saying "on a real network this transaction could not be submitted without a
restore first".

| Key | Test | What is stranded |
|---|---|---|
| `Task(u64)` | `test_expired_task_entry_strands_owner_escrow` | the owner's full reward in the pooled contract balance |
| `KeeperReward(Address)` | `test_expired_keeper_reward_entry_strands_earnings` | a keeper's credited execution reward |
| `KeeperStake(Address)` | `test_expired_keeper_stake_entry_strands_collateral` | a keeper's bonded stake |
| `UnbondRequest(Address)` | `test_expired_unbond_request_strands_pending_withdrawal` | stake already moved out of `KeeperStake` but not yet withdrawn |
| `PendingReward(Address)` | `test_expired_pending_reward_entry_strands_credits` | execution credits inside their dispute window |
| `Slash(u64)` | `test_expired_slash_record_forecloses_appeal_refund` | an upheld appeal's refund path |

These are **accepted risks**, not bugs: Soroban's TTL model requires the
beneficiary (or a keeper bot acting for it) to restore an archived footprint,
and the contract has no authority to do that on a user's behalf. The mitigation
is operational — keepers should withdraw promptly, owners should not register
tasks they will not monitor, and indexers should alert on entries nearing TTL.
