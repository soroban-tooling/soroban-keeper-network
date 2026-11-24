# Audit Scope

This is the auditor-facing map of the shipped codebase. It supersedes the
earlier registry-only scope note: it covers every contract crate, records the
current size of each, and collects the known issues and accepted tradeoffs
from every completed security review. It is a starting point, not a
conclusion, and should be extended as new surfaces ship.

Snapshot: commit `22fc723` on `main`, refreshed for issue #736.

Line counts use `src/**/*.rs` excluding files under `test/` or `tests/` and
excluding `mocks.rs`. "Source" is the production surface an auditor reads;
"tests" is the separate test-tree size, reported so growth in the test suite
is not mistaken for growth in contract logic. Inline `#[cfg(test)]` modules
that live in a production file are counted as source because they share the
file with production code.

## Contract crates

| Crate / subcrate | Source lines | Test lines | Status | Primary artifacts |
|---|---:|---:|---|---|
| `contracts/keeper-registry` | 3,816 | 7,199 | Shipped, ABI version 7 | [`ARCHITECTURE.md`](ARCHITECTURE.md), [`STAKING_DESIGN.md`](STAKING_DESIGN.md), [`REPUTATION_DESIGN.md`](REPUTATION_DESIGN.md), [`TASK_CONDITIONS_DESIGN.md`](TASK_CONDITIONS_DESIGN.md), [`VERIFIER_DESIGN.md`](VERIFIER_DESIGN.md), `src/task.rs`, `src/staking.rs`, `src/batch.rs`, `src/views.rs` |
| `contracts/treasury` | 848 | 1,403 | Shipped, ABI version 1 | [`TREASURY_DESIGN.md`](TREASURY_DESIGN.md), [`TREASURY_EVENTS.md`](TREASURY_EVENTS.md), `src/distribution.rs`, `src/internal.rs` |
| `contracts/governance` | 3,161 | 373 | Shipped | [`GOVERNANCE_DESIGN.md`](GOVERNANCE_DESIGN.md), [`GOVERNANCE_AUDIT_SCOPE.md`](GOVERNANCE_AUDIT_SCOPE.md), `src/lib.rs` |
| `contracts/governance-token` | 980 | 0 | Shipped | [`GOVERNANCE_DESIGN.md`](GOVERNANCE_DESIGN.md), `src/lib.rs` |
| `contracts/conditions/oracle-deviation` | 252 | 0 | Shipped | [`TASK_CONDITIONS_DESIGN.md`](TASK_CONDITIONS_DESIGN.md), `src/lib.rs` |
| `contracts/conditions/price-threshold` | 466 | 0 | Shipped | [`TASK_CONDITIONS_DESIGN.md`](TASK_CONDITIONS_DESIGN.md), `src/lib.rs` |
| `contracts/conditions/time-window` | 354 | 0 | Shipped | [`TASK_CONDITIONS_DESIGN.md`](TASK_CONDITIONS_DESIGN.md), `src/lib.rs` |
| `contracts/oracle-client` | 551 | 0 | Shipped | [`ORACLE_DESIGN.md`](ORACLE_DESIGN.md), `src/lib.rs` |
| `contracts/verifiers/test-support` | 543 | 0 | Test support only, not a production verifier | [`VERIFIERS.md`](VERIFIERS.md), [`VERIFIER_DESIGN.md`](VERIFIER_DESIGN.md), `src/lib.rs` |

The registry's verifier surface is shipped: `register_task` accepts an
optional verifier address, `execute_task` calls `IKeeperVerifier` before
crediting a keeper, and `update_verifier` lets the task owner change it.
Reference verifier implementations remain catalogued as blocked in
[`VERIFIERS.md`](VERIFIERS.md), and `contracts/verifiers/test-support` is the
test harness, not an audited production verifier. Audit the trust boundary at
the call site in `contracts/keeper-registry/src/verifier.rs` and
`contracts/keeper-registry/src/task.rs` regardless of which verifier a task
attaches.

## Surface to artifact map

| Surface | Start here |
|---|---|
| Task lifecycle and escrow (register, claim, execute, cancel, expire, withdraw) | [`ARCHITECTURE.md`](ARCHITECTURE.md) money invariants I-1 to I-7, `src/task.rs` |
| Admin controls (pause, fee, sweep, transfer admin, upgrade) | [`ARCHITECTURE.md`](ARCHITECTURE.md) trust model, `src/admin.rs` |
| Batch registration | [`BATCH_OPERATIONS.md`](BATCH_OPERATIONS.md), `src/batch.rs` |
| TTL and archival | [`ARCHITECTURE.md`'s TTL section](ARCHITECTURE.md#ttl--archival-strategy), `src/internal.rs` |
| Staking, unbonding, slashing and dispute windows | [`STAKING_DESIGN.md`](STAKING_DESIGN.md), [`STAKING_SECURITY_REVIEW.md`](STAKING_SECURITY_REVIEW.md), `src/staking.rs` |
| Keeper reputation | [`REPUTATION_DESIGN.md`](REPUTATION_DESIGN.md), [`REPUTATION_SECURITY_REVIEW.md`](REPUTATION_SECURITY_REVIEW.md), `src/reputation.rs` |
| Treasury fee routing and distribution | [`TREASURY_DESIGN.md`](TREASURY_DESIGN.md), [`TREASURY_EVENTS.md`](TREASURY_EVENTS.md), `sweep_fees` in registry `src/admin.rs` |
| Governance and KPRS token | [`GOVERNANCE_AUDIT_SCOPE.md`](GOVERNANCE_AUDIT_SCOPE.md), [`GOVERNANCE_DESIGN.md`](GOVERNANCE_DESIGN.md) |
| Verifier trust boundary | [`VERIFIER_DESIGN.md`](VERIFIER_DESIGN.md), [`VERIFIERS.md`](VERIFIERS.md), `src/verifier.rs`, the gate in `src/task.rs` |
| Task conditions | [`TASK_CONDITIONS_DESIGN.md`](TASK_CONDITIONS_DESIGN.md), [`TASK_CONDITIONS_SECURITY_REVIEW.md`](TASK_CONDITIONS_SECURITY_REVIEW.md) |
| Oracle client | [`ORACLE_DESIGN.md`](ORACLE_DESIGN.md), `contracts/oracle-client/src/lib.rs` |

The verifier surface is the one trust boundary where the registry calls code
it does not control, on a path that decides whether a keeper is paid. An
auditor should confirm that the `try_verify` call in `execute_task` runs
strictly before any reward crediting or task status mutation, and that its
return value only gates an `if` branch rather than receiving any capability to
move funds. Reference verifier implementations remain absent; the threat-model
write-up scoped as issue 0089 was never written, so
[`VERIFIER_DESIGN.md`](VERIFIER_DESIGN.md)'s failure-semantics and trust-model
sections are the starting point for that analysis.

## Money and state invariants

The registry's seven numbered money invariants remain the primary correctness
statement, in [`ARCHITECTURE.md`](ARCHITECTURE.md) and the property tests in
`contracts/keeper-registry/src/invariants.rs`. The treasury's T-1 solvency
statement is in [`TREASURY_DESIGN.md`](TREASURY_DESIGN.md) section 6 and is
exercised by `contracts/treasury/src/test/conservation.rs`. A consolidated
invariants reference is being added under issue #734; until it merges on
`main`, read the design document and the property tests directly.

## Known issues and accepted tradeoffs by review

| Surface | Review | Known issues and accepted tradeoffs |
|---|---|---|
| Staking, unbonding, slashing, execution dispute window | [`STAKING_SECURITY_REVIEW.md`](STAKING_SECURITY_REVIEW.md) | Three findings fixed with tests: slash can draw from pending unbond, dispute-window boundary made inclusive on both sides, and `raise_slash_appeal` renews TTL. Accepted risk: `slash` is protected by a single admin key; a future multisig or timelock gate on `slash` specifically is recommended before a deployment carrying meaningful value. The appeal process cannot stall a legitimate slash because the slash executes first. |
| Keeper reputation | [`REPUTATION_SECURITY_REVIEW.md`](REPUTATION_SECURITY_REVIEW.md) | Three open limitations: low-cost self-dealing inflates the score, decay resets on any action so timing holds a score indefinitely, and an eligibility floor penalizes risk-taking and shuts out new keepers. Treat `score_bps` and `effective_reputation` as unauthenticated, self-reportable data until the self-dealing mitigation ships. Keep any reputation floor at 0 until then. |
| Treasury distribution | [`TREASURY_SECURITY_REVIEW.md`](TREASURY_SECURITY_REVIEW.md) | Three concerns checked and found not to apply: recipient reconfiguration cannot strand in-flight funds, upgrade cannot bypass conservation, and the treasury has no path into registry escrow. No open finding. Pro-rata dust is bounded and never collected. |
| Governance and KPRS token | [`GOVERNANCE_SECURITY_REVIEW.md`](GOVERNANCE_SECURITY_REVIEW.md) | Review is specification-based, not code-based. Open items: state the plutocracy risk and voting threshold explicitly, verify the governance address before `transfer_admin`, define proposal execution ordering, and test timelock boundaries. Accepted tradeoffs: no hard cap on voting power, permissionless execution after timelock, and no emergency veto. Migration to governance is irreversible. |
| Task conditions | [`TASK_CONDITIONS_SECURITY_REVIEW.md`](TASK_CONDITIONS_SECURITY_REVIEW.md) | Accepted limitation: a task owner can attach a verifier or condition that excludes specific keepers, mitigated by advisory curated-verifier guidance, pre-claim simulation, event accountability, and bot policies. Panics are isolated and treated as verification failure. Verifier observation is not a front-running vector because events are already public. The `is_claimable` gap remains a named backlog item. |
| Indexer API | [`INDEXER_SECURITY_REVIEW.md`](INDEXER_SECURITY_REVIEW.md) | Three high findings with scoped follow-ups: API-key rate-limit buckets can be minted before authentication (#579), unbounded history work and arbitrary leaderboard windows (#580), and WebSocket connections are not bounded (#581). The API is not approved for general availability until those are closed or explicitly replaced. No SQL injection or private-data disclosure was found. |
| Keeper bot v2 | [`KEEPER_BOT_V2_SECURITY_REVIEW.md`](KEEPER_BOT_V2_SECURITY_REVIEW.md) | All six findings resolved by design: localhost or UNIX-socket binding and secret-safe metrics labels, read-only inspection interface, no secrets in persisted state, file permissions and optional encryption at rest, in-memory-only secret hydration with log scrubbing, and secret-manager errors logged without response bodies. |

## Related operational documents

- [`SECURITY_ARITHMETIC_REVIEW.md`](SECURITY_ARITHMETIC_REVIEW.md): checked
  arithmetic, rounding direction, and bounded iteration in the registry and
  treasury (issues #737 and #738).
- [`OBSERVABILITY_RETROSPECTIVE.md`](OBSERVABILITY_RETROSPECTIVE.md): what
  epic E18 shipped, implemented in open PRs, and deferred (issue #732).
- [`CI.md`](CI.md): why workspace-wide Cargo commands currently fail on
  pre-existing duplicate manifest keys and how verification is performed.

## Out of scope

- `examples/keeper-bot/` and `examples/batch-register/` are illustrative
  off-chain code, not production infrastructure, per
  [`SECURITY.md`](../SECURITY.md)'s "Out of Scope" section. The indexer and
  keeper bot v2 are covered through their own review documents above, not as
  contract crates.
- Theoretical attacks with no practical exploit path.

## Maintaining this document

Recount source and test lines whenever a contract crate gains or loses a
production file, and update the snapshot commit. When an epic security review
lands, add its known issues and accepted tradeoffs to the table above rather
than leaving them only in the epic document. Update the verifier status once
reference implementations land, and fold in the consolidated invariants
reference when issue #734 merges.
