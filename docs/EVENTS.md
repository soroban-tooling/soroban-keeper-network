# Events for a Future Indexer (Epic E14)

Epic E14 (Event Indexer, wave 3) will eventually need to consume every
event this contract emits. This document exists so the indexer epic does
not have to rediscover this contract's event shapes from scratch when it
starts — the general event table already lives in
[README.md's Events section](../README.md#events) (transcribed from the
`emit_*` functions per wave-1 issue 0017), so this file does not duplicate
that whole table. It scopes down specifically to the events a
verifier-gated task produces, since that is what a task-execution-status
dashboard or keeper-bot integration built on top of an indexer would need
to reconstruct "is this task's proof requirement satisfied, and by whom."

## Implementation status

**As of this writing, neither event below is implemented.** They are
documented in README's event table ahead of the verifier feature (epic
E04, issues 0072–0096) actually shipping — see
[`docs/AUDIT_SCOPE.md`](AUDIT_SCOPE.md)'s verifier-surface entry for the
full implementation-status accounting. Concretely:

- `contracts/keeper-registry/src/events.rs` has no `emit_verifier_updated`
  or `emit_verification_failed` function.
  `update_verifier` is not a contract entry point.
  `execute_task` never calls a verifier and cannot emit a rejection.
- The schema below is therefore the **proposed** shape — sourced from
  README's existing table entries plus backlog issues 0080 and 0093,
  which specify these exact topics and payloads as part of epic E04's
  scope — not a shape you can currently observe on testnet or mainnet.

This document should be treated as a target for 0080/0093 to implement
against, and the indexer epic (E14) should not begin consuming these two
events until this status line is updated to say they are shipped.

## Verifier-related events

### `VerifierUpdated`

| | |
|---|---|
| Emitted by | `update_verifier` (issue 0081/0093 — not yet an entry point) |
| Topics | `("verifier", "task")` |
| Data | `(task_id: u64, verifier: Option<Address>)` |

Fires whenever a task's attached verifier is set, changed, or cleared
while the task is still `Pending` (verifier updates are rejected once a
task is `Claimed`, per `docs/VERIFIER_DESIGN.md`'s §4 "Attachment
timing"). `verifier: None` means the verifier was cleared, not that the
field is absent from the payload.

| Field | Indexer-relevant purpose |
|---|---|
| `task_id` | Primary key to join against the task's other lifecycle events (`TaskRegistered`, `TaskClaimed`, etc.) in the indexer's task table. |
| `verifier` | The attached verifier's address, or `None` if cleared. Lets an indexer show which tasks require on-chain proof verification and by which verifier contract, without polling `get_task` for every task on every update. |

**Registration-time attachment.** A verifier can also be attached at
`register_task` time (issue 0073), not only via a later
`update_verifier` call. Per backlog issue 0093's acceptance criteria,
whether that is surfaced as an additive field on the existing
`TaskRegistered` event or as a first `VerifierUpdated` emission
immediately following registration is not yet decided — 0093 explicitly
defers that choice to whoever implements it, and this document does not
resolve it either. Whichever is chosen, an indexer must be able to learn
a task's initial verifier (if any) without missing it, so the eventual
implementation issue should update this document's status line and this
paragraph once the choice is made.

### `TaskVerificationFailed`

| | |
|---|---|
| Emitted by | `execute_task` (issue 0080 — not yet implemented) |
| Topics | `("verfail", "task")` |
| Data | `(task_id: u64, keeper: Address)` |

Fires when a task has a verifier attached and that verifier's `verify`
call returns `false`, or panics (both map to the same
`KeeperError::VerificationFailed`, per `docs/VERIFIER_DESIGN.md`'s §2
"Failure semantics"). `TaskVerificationFailed` and `TaskExecuted` are
mutually exclusive for a given `execute_task` call — a rejection emits
this event and returns an error, so no `TaskExecuted` follows, and the
task remains `Claimed` (retryable).

| Field | Indexer-relevant purpose |
|---|---|
| `task_id` | Joins to the same task row as every other lifecycle event. |
| `keeper` | Which keeper's proof was rejected — lets a dashboard distinguish "this task has never been attempted" from "this task has been attempted and rejected N times," and lets a keeper-bot-facing view surface a keeper's own rejection history. |

**Not included: a failure reason.** Per `docs/VERIFIER_DESIGN.md`'s §1,
`verify` returns a plain `bool` with no typed error detail, and the
registry's event intentionally does not attempt to relay a
verifier-specific reason code (that would couple the registry's ABI to
every verifier's own error taxonomy). A verifier contract that wants to
communicate *why* a proof failed is expected to emit its own event before
returning `false`; an indexer wanting that detail would need to also
index the specific verifier contract's own events, joined by `task_id`
and ledger sequence, not this event alone.

## Cross-references

- [README.md's Events section](../README.md#events) — the full,
  canonical event table for the contract (all events, not just
  verifier-related ones).
- [`docs/VERIFIER_DESIGN.md`](VERIFIER_DESIGN.md) — the interface and
  failure-semantics design these two events implement.
- [`docs/AUDIT_SCOPE.md`](AUDIT_SCOPE.md) — verifier surface implementation
  status.

**For whoever kicks off epic E14:** add this document as a dependency of
that epic's first issue once wave 3 is drafted, per this issue's own
acceptance criteria.
