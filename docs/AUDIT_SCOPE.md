# Audit Scope

This is a minimal audit-scope document for `contracts/keeper-registry`,
listing the surfaces an external auditor needs to review and the primary
artifact(s) to start from for each. It exists ahead of epic E19 (Security
& Audit Readiness) formally starting — security scope for shipped and
in-flight code should not wait on an epic's scheduling — and it is meant
to be extended, not treated as final, once E19 kicks off.

## Scope items

| Surface | Primary artifacts | Status |
|---|---|---|
| Task lifecycle & escrow (register / claim / execute / cancel / expire / withdraw) | [`docs/ARCHITECTURE.md`](ARCHITECTURE.md)'s money invariants `I-1`–`I-7`, `contracts/keeper-registry/src/task.rs` | Shipped |
| Admin controls (pause, fee, sweep, transfer-admin, upgrade) | [`docs/ARCHITECTURE.md`](ARCHITECTURE.md)'s trust model, `contracts/keeper-registry/src/admin.rs` | Shipped |
| Batch registration | [`docs/BATCH_OPERATIONS.md`](BATCH_OPERATIONS.md), `contracts/keeper-registry/src/batch.rs` | Shipped |
| TTL / archival | [`docs/ARCHITECTURE.md`](ARCHITECTURE.md#ttl--archival-strategy), `contracts/keeper-registry/src/internal.rs` | Shipped |
| **Verifier integration (epic E04)** | See below | **Proposed — not yet implemented** |

## Verifier surface (epic E04)

Epic E04 adds a meaningfully new trust boundary: an arbitrary,
task-owner-chosen third-party contract (`IKeeperVerifier`) called from
`execute_task`. That is a different threat model from every other surface
in this table — the registry executes code it does not control, on a path
that gates whether a keeper gets paid — and it must be named explicitly
here rather than assumed to be covered by a general "review the contract"
instruction.

**Current implementation status, as of this writing:** the verifier
feature exists only as a design record. `docs/VERIFIER_DESIGN.md` (issue
0071) documents the proposed `IKeeperVerifier` interface and its status is
explicitly "Proposed." No contract code implements it yet — there is no
`IKeeperVerifier` trait, no `Task.verifier` field, no `verifier` parameter
on `register_task`, and `execute_task` never calls out to a verifier. The
only trace of the feature in shipped code today is a reserved error
discriminant, `KeeperError::IncompatibleVerifierInterface = 20` in
`contracts/keeper-registry/src/errors.rs`, held aside so a future PR does
not have to renumber existing variants. An auditor reviewing `main` today
will not find this surface in the compiled contract — but reviewing the
design now, before implementation lands, is exactly what lets the design
itself be audited before code is built on top of it.

The primary artifacts an auditor should start from, once this lands (and
should review as design intent in the meantime):

- **Interface** — [`docs/VERIFIER_DESIGN.md`](VERIFIER_DESIGN.md) (issue
  0071): the `IKeeperVerifier` trait shape, why `keeper` is part of the
  signature, and the six numbered design decisions (interface shape,
  failure semantics, resource budget, attachment timing, trust model,
  backward compatibility).
- **Reference implementations** — the signature, oracle, and
  tx-inclusion verifiers (issues 0077, 0078, 0079). **Not yet
  implemented** — there is no `IKeeperVerifier` implementation anywhere
  in `contracts/` today (also noted in
  [`docs/VERIFIERS.md`](VERIFIERS.md)'s resource-cost catalog, which is
  blocked on the same absence). Once any of these land, this scope item
  should be updated with a link to each implementation.
- **Failure-handling policy** — covered within
  [`docs/VERIFIER_DESIGN.md`'s §2 "Failure semantics"](VERIFIER_DESIGN.md)
  (issue 0075): a panicking or `false`-returning verifier both map to
  `KeeperError::VerificationFailed` via `try_invoke_contract`, never a
  transaction-wide revert, and task state is left unchanged either way. A
  dedicated failure-handling document does not exist separately from this
  section.
- **Security-considerations write-up** — issue 0089 (the threat-model
  write-up covering the griefing vector, panic isolation, resource-budget
  cost transfer, and whether a malicious verifier could steal funds
  outright). **Not yet written.** This is a real gap in scope, not filled
  by this document: 0089 requires 0074/0075/0076 to exist first (per its
  own `depends_on`), and none of those have landed. Until it exists, an
  auditor's starting point for the verifier surface's threat model is
  `docs/VERIFIER_DESIGN.md`'s §2 (failure semantics) and §5 (trust model)
  sections directly, which reason informally about the same questions
  0089 is meant to formalize.

**What an auditor should confirm once the surface is implemented**,
per `docs/VERIFIER_DESIGN.md`'s own reasoning: that the verifier call in
`execute_task` happens strictly before any reward-crediting or task-status
mutation, and that its return value only gates an `if`-branch rather than
being handed any capability to move funds, credit a keeper balance, or
mutate a `Task` field itself. This is the substance behind backlog issue
0132's planned invariant (a verifier can gate a payout but never move
funds itself) — not yet a numbered invariant in
[`docs/ARCHITECTURE.md`](ARCHITECTURE.md), since the code it would
describe does not exist yet either.

## Out of scope

- `examples/keeper-bot/` and `examples/batch-register/` — illustrative
  off-chain code, not production infrastructure (per
  [`SECURITY.md`](../SECURITY.md)'s "Out of Scope" section).
- Theoretical attacks with no practical exploit path.

## Maintaining this document

Extend the table above as new surfaces ship or as epic E19 defines a
fuller audit process. Update the verifier row's "Status" once
0072–0096 land, and fill in the reference-implementation and
security-considerations links as those issues close.
