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
[0201-task-storage-hot-cold-split.md](../.github/backlog/issues/0201-task-storage-hot-cold-split.md).

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
| Q2 — hot/cold split | Real, measurable win on the write side for the two hottest entry points | Follow-up issue filed: [0201](../.github/backlog/issues/0201-task-storage-hot-cold-split.md) |
| Q3 — verifier field placement | Separate `DataKey::TaskVerifier(task_id)` is cheaper than a `Task` field for the common no-verifier case | Recorded here for issue 0072 to apply when implemented |
