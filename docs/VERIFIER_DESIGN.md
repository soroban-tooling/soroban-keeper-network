# Verifier Design (E04)

This is the design document for the `IKeeperVerifier` interface — the
decision record the other issues in E04 (0072–0096) implement against. No
contract code changes are made by this document; it exists so the
interface is agreed on paper before several PRs build on top of it.

## Context

The MVP (wave 1) trusts the claiming keeper to submit an honest `proof` —
`execute_task` records it but never checks it against anything (see the
README's Known Design Decisions section). E04 replaces "trust the keeper"
with an **optional**, per-task, on-chain verification callback: a task
owner can attach a verifier contract at registration time, and
`execute_task` calls it before crediting the keeper.

## 1. Interface shape

```rust
/// Implemented by any contract a task owner wants to use as a per-task
/// proof verifier. Registered per-task via `register_task`'s optional
/// `verifier` parameter (see §4, Attachment timing).
pub trait IKeeperVerifier {
    /// Returns `true` if `proof` is a valid witness that `keeper` correctly
    /// executed `task_id`'s off-chain work, `false` otherwise.
    ///
    /// Must not panic on a merely-invalid proof — return `false`. A panic
    /// is reserved for the verifier being fundamentally broken (see §2),
    /// and `execute_task` treats it as equivalent to `false` regardless.
    fn verify(env: Env, task_id: u64, keeper: Address, proof: Bytes) -> bool;
}
```

**`keeper` is part of the signature.** A verifier that only receives
`task_id` and `proof` cannot bind the proof to the specific keeper
claiming credit — anyone who observes a valid `(task_id, proof)` pair
on-chain (proofs are logged in the `exec` event, per wave 1's issue #4)
could resubmit it under their own claim on a *different* task the same
verifier is attached to, if the proof format doesn't happen to encode
enough context itself. Requiring the registry to pass `keeper` explicitly
means every reference verifier the registry ships (§7–9) can and should
check the proof against that specific address, rather than relying on
every third-party verifier author to remember to do so unprompted.

**No return-value error detail.** `verify` returns a plain `bool`, not a
`Result<bool, E>` with a typed reason. A verifier that wants to
communicate *why* a proof failed (for off-chain debugging, e.g. by a
keeper bot deciding whether a proof is worth resubmitting) should emit its
own event before returning `false` — the registry's `VerificationFailed`
event (§8) intentionally does not attempt to relay a verifier-specific
reason code, since that would couple the registry's ABI to every
verifier's own error taxonomy.

## 2. Failure semantics

**If the verifier call panics, `execute_task` catches it and returns a
typed error rather than reverting the whole transaction.**

Soroban's host provides exactly this primitive:
`Env::try_invoke_contract` catches a callee panic (and any other callee
error) and surfaces it as a `Result` to the caller, as opposed to
`Env::invoke_contract`, which propagates the callee's failure straight
through and aborts the calling transaction too. `execute_task` uses
`try_invoke_contract`, mapping any panic *or* an explicit `false` return
to the same outcome: the execution attempt fails with
`KeeperError::VerificationFailed`, task state is unchanged (no partial
credit, no status transition — enforced the same way every other
rejection path in `execute_task` already works, per I-3/I-5 in
`docs/ARCHITECTURE.md`), and the keeper is free to retry (their claim
lock is untouched) or the task can still expire/be cancelled normally by
its other paths.

This was a real design choice, not a foregone conclusion: propagating the
panic (aborting the whole transaction) is *also* safe from a funds
perspective — no state changes were persisted, since Soroban transactions
are atomic — but it would mean a single misbehaving or buggy verifier
contract could make `execute_task` unusable for every task attached to
it, with no way to recover the escrow except waiting for the deadline and
falling back to `expire_task`. Returning a typed error instead gives the
keeper (or the task owner, via `cancel_task` once the lock lapses, or
anyone via `expire_task` once the deadline passes) every existing recovery
path immediately, rather than only the slowest one.

## 3. Resource budget

**No documented budget ceiling is reserved for the verifier call; the
whole transaction's resource footprint (set by whoever submits it) is
the only limit.**

Soroban does not give a contract an in-band way to sub-allocate a
resource budget to a specific cross-contract call and enforce it — the
`Budget` type in `soroban-sdk`'s `testutils` is a test-only
measurement/reset tool, not a runtime limiting mechanism a contract can
invoke against a callee. The actual ceiling on a cross-contract call's
CPU/memory cost is the calling transaction's own resource footprint,
declared by whoever submits it (a keeper bot, in this case) before
simulation/submission.

Practically, this means: a keeper choosing to execute a task with an
expensive verifier attached pays for that cost in their own transaction's
resource footprint, and an excessively expensive verifier simply makes the
transaction fail at the network's resource-limit boundary (the same
failure mode as any other transaction that tries to do too much) — not a
distinct, registry-specific error. `docs/FUZZING.md`'s target-status table
and this repo's keeper-bot example (`examples/keeper-bot`) should document
the practical implication: a keeper bot integrating with a
verifier-gated task should simulate the transaction first (standard
Soroban RPC `simulateTransaction`) to estimate the real cost before
committing to a fee, exactly as it should for any other execution — this
isn't a new burden E04 introduces, just one that becomes newly relevant
once a verifier call is in the path.

## 4. Attachment timing

**A verifier is chosen at `register_task` time and is immutable once a
keeper has claimed the task (per 0082); the owner may still change it
while the task is `Pending`.**

Rationale: a keeper decides whether a task is worth claiming partly based
on how hard/expensive it'll be to produce a satisfying proof — that
decision is made against whatever verifier is attached *at claim time*.
Letting the owner swap the verifier out from under an already-claimed
task (after the keeper has done off-chain work matching the old verifier)
would let an owner grief a keeper by attaching an impossible-to-satisfy
verifier post-claim, with no way for the keeper to recover except waiting
out the lock window. Locking the verifier at claim time closes that; still
allowing changes pre-claim keeps it consistent with every other
owner-adjustable field on a `Pending` task (`increase_reward`,
`extend_deadline` already work this way).

## 5. Trust model

**Permissionless: any address may be used as a verifier, consistent with
the registry's existing trust model** (keepers are permissionless;
correctness is enforced by contract logic, not a whitelist — see
`docs/ARCHITECTURE.md`'s Trust model section).

A registry-level admin-curated allow-list (630's fork, tracked separately
as issue 0092) is explicitly *not* part of this baseline design — adding
one is a strictly separate, optional extension an operator could layer on
top (e.g. a wrapper contract that only forwards to allow-listed
verifiers), not a change to `IKeeperVerifier` or `execute_task` itself.
Baking an allow-list into the core registry would mean every dApp using
the registry inherits whichever admin's curation policy, which cuts
against the "admin can never gate ordinary task/keeper activity" property
I-5 already establishes for fee sweeping — extending that same principle,
an admin should not get to gate *which verifiers are usable* either,
without an explicit, separately-designed extension opting into that
tradeoff.

## 6. Backward compatibility

**A task with no verifier attached behaves identically to every existing
task today** — `execute_task` performs the verifier call only when
`Task.verifier` is `Some(_)`; when it's `None`, execution proceeds exactly
as it does on `main` right now, with no additional call, no additional
gas cost, and no behavior change. Existing tasks registered before this
epic ships have no `verifier` field populated (backward-compatible
storage migration: `Task.verifier: Option<Address>` defaults to `None`
for any task read that predates this field, the same pattern the existing
`Task` struct already handles for schema evolution elsewhere in this
contract). Any dApp integration written against the current ABI continues
to work with zero changes required — attaching a verifier is opt-in per
task, not a new required parameter with no default.

## 7. Prior art

Before treating this design as final, it is worth checking how comparable
keeper/automation networks handle the same underlying problem — "how does
the network know the off-chain-triggered work was actually done
correctly" — to see whether this design matches established patterns or
deviates from them for a stated reason. Three systems were reviewed
directly against their own documentation (not secondhand summaries);
each claim below is sourced to the specific page it comes from.

### Chainlink Automation (formerly Keepers)

Chainlink Automation nodes call a registered upkeep contract's
`checkUpkeep` off-chain (simulated) to decide whether `performUpkeep`
should run, then submit `performUpkeep` on-chain with the `performData`
that `checkUpkeep` returned. Per the
[Automation Interfaces reference](https://docs.chain.link/chainlink-automation/reference/automation-interfaces),
there is **no separate on-chain verifier contract that checks
`performData` before `performUpkeep` executes**. Instead, the
documentation places that responsibility entirely on the upkeep contract
itself: "This data should always be validated against the contract's
current state," and `performUpkeep` is expected to re-check its own
preconditions at the start of the call rather than trust that
`checkUpkeep`'s earlier simulation still holds. Execution correctness is
therefore enforced by the target contract's own `require`/state checks —
not by a pluggable verifier that inspects a keeper-submitted proof
against an independent criterion.

For work that genuinely requires off-chain computation with a stronger
correctness guarantee, Chainlink's separate DON-based products (Chainlink
Functions) use decentralized consensus among multiple independent oracle
nodes rather than a single verifier: per the
[Chainlink Functions docs](https://docs.chain.link/chainlink-functions),
"the DON... aggregates all the independent return values from each
execution and sends the final result back to your smart contract," which
"ensures that a minority of the network cannot manipulate the response."
The exact aggregation/threshold mechanics are documented separately and
were not verified in this survey — flagged here as uncertain rather than
asserted.

### Gelato (Web3 Functions)

Gelato's automated-execution model is structurally similar to Chainlink
Automation's: a relayer/executor calls a target contract, and per the
[Web3 Functions docs](https://docs.gelato.cloud/web3-services/web3-functions),
target contracts "do not have access restrictions like an `onlyOwner`
modifier, unless the user's dedicated `msg.sender` address is
whitelisted" — i.e., the called contract is expected to authorize and
validate the call itself (via a whitelisted relayer address plus its own
state checks), not delegate that check to a separate verifier contract
supplied by the automation network. As with Chainlink Automation, no
generic "submit a proof, an attached verifier checks it" pattern is
described.

### OpenZeppelin Defender (Actions / Relayer)

Defender is architecturally the most different of the three: per the
[Actions module docs](https://docs.openzeppelin.com/defender/module/actions),
Actions are JavaScript automations that run inside OpenZeppelin's own
managed infrastructure ("code for each action is isolated in Defender,
and actions are restricted via strict access controls") and submit
transactions through an integrated Relayer. There is **no on-chain
verification step at all** — Defender is a centralized, trusted-operator
automation service, not a permissionless network with an on-chain
correctness check of any kind. Trust is placed in OpenZeppelin's
infrastructure and access controls, not in cryptography or contract
logic.

### Comparison to this design

| | Who checks correctness | Where | Trust model |
|---|---|---|---|
| Chainlink Automation | The target (upkeep) contract itself, via its own state checks | On-chain, inside the called contract | Permissionless keepers; correctness enforced by the callee, not a third party |
| Chainlink Functions (DON) | Multiple independent oracle nodes, aggregated | Off-chain consensus, then one on-chain write | Decentralized quorum; no single node's result is trusted alone |
| Gelato Web3 Functions | The target contract itself (whitelisted relayer + its own checks) | On-chain, inside the called contract | Similar to Chainlink Automation |
| OpenZeppelin Defender | Nobody, on-chain | N/A — off-chain trusted execution | Fully centralized; trust in OpenZeppelin's infrastructure |
| **This design (proposed, issue 0071)** | **A separate, task-owner-chosen `IKeeperVerifier` contract, given the keeper's proof** | **On-chain, called from `execute_task` before crediting** | **Permissionless keepers *and* permissionless verifiers — any address, chosen per task** |

**Where this design agrees:** like Chainlink Automation and Gelato, this
registry keeps correctness-checking on-chain and does not rely on a
centralized trusted operator (unlike Defender) — consistent with
`docs/ARCHITECTURE.md`'s existing permissionless-keeper trust model.

**A genuine point of difference — and a real question for this design,
not just a confirmation.** Neither Chainlink Automation nor Gelato has a
concept of a separate, arbitrary, per-task **verifier contract** distinct
from the target contract itself; correctness-checking there is done by
the same contract being called, using its own state, not by a
second contract instructed to evaluate a keeper-submitted "proof" against
criteria opaque to the registry. This project's design is closer in
*spirit* to Chainlink Functions' idea of "don't just trust one party's
claim" — but where Functions gets that guarantee from **decentralized
consensus across multiple independent nodes**, this design gets it from
**a single verifier contract, chosen unilaterally by the task owner**
(§5, Trust model: "any address may be used as a verifier"). That is a
materially weaker guarantee: a single buggy or malicious verifier is a
single point of failure for every task attached to it, with no
cross-checking analogous to Functions' quorum, and (per §5's own
reasoning) no baseline allow-list to mitigate it. Whether that tradeoff
is acceptable depends entirely on what "verifier" is expected to mean in
practice for this protocol:

- If a verifier is expected to be a simple, deterministic, publicly
  auditable check (e.g. a signature verifier or an oracle-price
  comparison — the three reference implementations planned in issues
  0077–0079 are exactly this shape), a single verifier contract is
  reasonable: its logic is checkable on-chain like any other contract,
  the same way an upkeep contract's own `require` statements are
  checkable in the Chainlink Automation / Gelato model. This **validates**
  0071's decision — the design is closer to those two systems' "the
  callee enforces its own correctness" pattern than it first appears,
  just with the check factored into a separate, reusable contract instead
  of inlined into every target contract.
- If a verifier is ever expected to attest to something that cannot be
  cheaply and deterministically re-checked on-chain by anyone reading its
  code (closer to what Chainlink Functions' DON consensus exists to
  solve), a single task-owner-chosen verifier provides materially weaker
  assurance than a quorum-based design, and that gap is not currently
  named anywhere in this document. This **challenges** 0071 to be
  explicit — in the reference-implementation issues (0077–0079) and the
  not-yet-written security-considerations doc (issue 0089) — about which
  category of verifier this design is actually built for, since the two
  cases have different risk profiles and the document as it stands does
  not draw that line.

## Summary of decisions

| Question | Decision |
|---|---|
| Interface shape | `fn verify(env, task_id, keeper, proof) -> bool` — `keeper` included to bind the proof to the specific claim |
| Failure semantics | `execute_task` uses `try_invoke_contract`; a panicking or `false`-returning verifier both map to `KeeperError::VerificationFailed`, never a transaction-wide revert |
| Resource budget | No in-contract ceiling reserved; the calling transaction's own resource footprint is the only limit — keeper bots should simulate first |
| Attachment timing | Chosen at `register_task`, owner-changeable while `Pending`, immutable once claimed |
| Trust model | Permissionless — any address may be a verifier; an admin allow-list is an optional, separate extension (0092), not baseline |
| Backward compatibility | `Task.verifier: Option<Address>`, `None` behaves identically to today, zero-cost when absent |

## Status

Implemented. The design from this document shipped in VERSION 3 of the
registry contract (issues 0072–0087), with the core verifier interface,
registry integration, and reference implementations complete. See the
Epic E04 Retrospective below for a summary of shipped items and studied-but-deferred investigations.

---

## Epic E04 Retrospective: Shipped vs Studied and Deferred

An item is only marked **Resolved** when a code or test reference is attached.
**Deferred** items link to their source issue for full reasoning.

### Shipped

**Core interface and registry integration** — the `IKeeperVerifier` interface
design from §1–6 shipped. Per CHANGELOG ([Unreleased], "Added — optional on-chain
proof verifier"):

- `Task.verifier: Option<Address>` field added to store per-task verifier
  (issue 0072).
- `register_task` now takes `verifier` parameter as eighth argument
  (issue 0073); `update_verifier` entry point lets owner change it while
  `Pending`.
- `execute_task` calls the attached verifier before crediting the keeper
  (issue 0074).
- Failure semantics implemented: verifier panic or `false` return both map to
  `KeeperError::VerificationFailed` and new `TaskVerificationFailed` event
  (issues 0075–0080).
- Backward-compatible design: tasks with no verifier (`None`) incur no extra
  cost and behave identically to MVP (issue 0087).
- Registry VERSION bumped from 2 to 3 (issue 0096).
- New events: `TaskVerificationFailed` (`("verfail", "task")`) and
  `VerifierUpdated` (`("verifier", "task")`).

**Reference verifiers** — three reference implementations shipped to exercise
the interface end-to-end (issues 0077–0079): signature-based proof verification,
oracle price attestation, and target-contract event inclusion. These provide
working examples for integrators.

**Trust model decision** — issue 0092's tension between permissionless and
admin-curated was resolved: the registry stays fully permissionless (any address
may be a verifier), consistent with the protocol's philosophy. An optional
separate admin-vetted-verifier registry is noted as a possible *extension*, not
a baseline change.

### Considered and Deferred

- **Interface versioning** (issue 0124) — deferred. The interface is stable
  enough in its current form that version-checking was not added to the
  baseline design. The registry's own VERSION field (issue 0096) provides
  ABI detection; if future breaking changes to the `verify` signature arise,
  versioning can be revisited. See [.github/backlog/issues/0124-verifier-interface-versioning.md](.github/backlog/issues/0124-verifier-interface-versioning.md) for full reasoning.

- **Composition (multi-verifier AND/OR)** (issue 0125) — deferred. The design
  keeps the registry single-verifier-per-task and pushes composition to the
  ecosystem: a task owner who wants to require both an oracle attestation
  *and* a signature can deploy a composite-verifier contract that calls both
  and ANDs the results. This keeps the registry simple and permissionless. See [.github/backlog/issues/0125-verifier-composition.md](.github/backlog/issues/0125-verifier-composition.md) for full reasoning.

- **Emergency disable (detach broken verifier post-claim)** (issue 0127) —
  deferred. The investigation found that allowing even an admin-only detach
  path reintroduces griefing risk (issue 0082 guards against owner-swap; admin
  bypass is not acceptable). The existing recovery path (expire_task after
  deadline) is confirmed as the accepted tradeoff. See [.github/backlog/issues/0127-verifier-emergency-disable.md](.github/backlog/issues/0127-verifier-emergency-disable.md) for full reasoning.

- **Prior-art research (ecosystem comparison)** (issue 0131) — deferred.
  A survey of comparable automation networks' verification approaches was not
  conducted before shipping. This can be added as a follow-up to enrich the
  documentation without blocking the implementation. See [.github/backlog/issues/0131-verifier-vs-ecosystem-research.md](.github/backlog/issues/0131-verifier-vs-ecosystem-research.md) for full reasoning.
