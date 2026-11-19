# System threat model and E19 retrospective

Status: internal source review complete for the documented baseline;
independent audit and mainnet release evidence outstanding.

Baseline: `22fc72304c950f539355330149dc30aef0b22a71`, with the dashboard,
release-readiness, indexer-limit, and audit-handoff changes stacked in the pull
requests linked by the delivery chain.

## System and assets

Soroban Keeper Network coordinates task escrow, keeper execution, optional
condition/verifier decisions, staking and disputes, treasury distribution,
governance, off-chain indexing, keeper bots, and an operator dashboard.

Assets requiring protection are:

- escrowed task rewards, keeper rewards, stake, fees, and treasury balances;
- administrator, governance, owner, keeper, and recipient authorization;
- task/verifier/dispute state integrity and event ordering;
- contract and indexer availability;
- keeper signing keys, API keys, deployment credentials, and release evidence;
- faithful, bounded indexing of public ledger data.

Public task, address, event, and contract-configuration data is not treated as
secret. Credentials, private signing material, and off-chain incident records
are secret even when the operations they authorize emit public events.

## Actors and trust boundaries

| Actor/boundary | Capability | Security expectation |
|---|---|---|
| Task owner | Funds and mutates owned tasks; selects verifier | Cannot spend other owners' escrow or bypass task-state rules. |
| Keeper | Claims and executes tasks; manages stake and rewards | Cannot receive duplicate payout or execute outside claim/verifier policy. |
| Contract admin | Pauses, changes bounded parameters, upgrades, sweeps, slashes | High-trust role; every action must require stored-admin authorization and emit evidence. |
| Governance participants | Propose, vote, queue, execute, cancel under policy | Snapshot/timelock/quorum rules must resist replay and later weakening. |
| Verifier/condition contract | Returns a decision during task evaluation | Untrusted code may reject, panic, or consume budget but must not move registry funds. |
| Reward token | Transfers value across contract boundary | Potentially adversarial callback; checks-effects-interactions and reentrancy tests apply. |
| Indexer client | Sends paths, filters, credentials, upgrades, and socket traffic | Fully untrusted; input and retained resources must be bounded. |
| Keeper bot/dashboard operator | Holds keys and submits transactions | Local secret storage and transaction review are trusted operational boundaries. |
| Release/deployment operator | Selects WASM, network, RPC, database, and proxy | Must produce independently reviewable release evidence. |

## Threats, controls, and status

| Threat | Primary controls | Status |
|---|---|---|
| Escrow theft, double payout, or fee/escrow mixing | State machine checks, CEI ordering, checked arithmetic, invariants I-1 through I-7, property/fuzz tests | Reviewed; independent audit pending. |
| Reentrancy through token or verifier calls | Effects before transfer, isolated verifier result, adversarial mocks and fuzz targets | Reviewed; residual coverage gaps are listed in `FUZZING.md`. |
| Unauthorized administration or involuntary admin transfer | `require_admin`, dual authorization for transfers, bounded setters, events | Reviewed; operational key custody remains external. |
| Stale claim, early dispute, or appeal replay | Ledger-bound windows, terminal-state checks, typed records | Reviewed in staking design/security review; mainnet evidence pending. |
| Governance replay, early execution, or threshold bypass | Proposal identity, voting snapshots, quorum/threshold checks, timelock, terminal states | Reviewed in governance security documents; external audit pending. |
| Malicious verifier steals funds or corrupts task state | Verifier has decision-only interface and is invoked before payout mutation | Design control reviewed; arbitrary verifier availability/cost remains an owner-selected risk. |
| Indexer SQL injection or error disclosure | Static SQL with binds, typed enums, generic public errors | No source-level finding. |
| Indexer request, socket, replay, or identity exhaustion | Authenticated identity selection, bounded token buckets, pagination, socket permits, replay and idle caps | Source controls implemented; production load/churn test pending. |
| Signing/API key disclosure | Environment-only bot keys, validation/redaction tests, hashed indexer API secrets, no client-side private keys | Source controls implemented; deployment secret store pending. |
| Wrong-network or wrong-contract transaction | Explicit network/contract configuration and wallet network checks | Dashboard/operator control implemented; human confirmation remains required. |
| Supply-chain or release substitution | Locked dependencies, CI, reproducible WASM/hash checklist, pinned audit baseline | Release evidence and independent audit pending. |

## Security invariants

The audit must preserve the numbered registry invariants in `ARCHITECTURE.md`,
the treasury solvency invariant in `TREASURY_DESIGN.md`, the staking and
governance invariants in their design documents, and these cross-system rules:

1. No off-chain service can authorize an on-chain action by itself.
2. A verifier can reject an execution but cannot transfer registry funds.
3. Pause blocks new exposure but not documented fund-recovery operations.
4. Failed or replayed terminal transitions do not advance state or pay twice.
5. Indexed state is reconstructible from ledger events and never overrides
   ledger truth.
6. Private keys and raw API secrets never enter contracts, events, browser
   storage, repository fixtures, or logs.

## E19 retrospective

### Reviewed

- Keeper-registry task, administration, batching, staking, reputation,
  verifier, storage/TTL, and upgrade surfaces.
- Treasury distribution and recipient administration.
- Governance proposal lifecycle and token authority.
- Indexer authentication, rate limiting, query validation, data exposure, and
  WebSocket resource retention.
- Keeper-bot key hygiene, dashboard transaction boundary, deployment guidance,
  fuzzing/property coverage, and audit documentation.

### Resolved in source

- Indexer keys are verified before selecting a rate-limit identity; invalid and
  revoked keys cannot mint buckets.
- REST history/list/aggregate queries have explicit request bounds.
- WebSocket sessions have global/per-client permits, validated filters,
  bounded replay, and idle/lag closure.
- Nightly fuzzing publishes source coverage and an explicit unreached-entry
  point ledger.
- Bot signing-key validation rejects placeholders and avoids secret reflection.
- A single audit-package index now pins scope and links threat, invariant,
  access-control, build, known-risk, and readiness evidence.

### Accepted or outstanding risk

- Mainnet remains `NO-GO` until every required item in
  `MAINNET_READINESS.md` has immutable evidence and named approval.
- No independent audit report is committed for the complete current system.
- Reputation self-dealing/decay limitations remain documented in
  `REPUTATION_SECURITY_REVIEW.md`; do not enable a restrictive reputation
  floor until the recommended mitigation is reviewed.
- Verifier resource use and correctness are selected by task owners; the core
  contract limits the blast radius but cannot make arbitrary verifier logic
  reliable.
- Indexer limits are process-local defaults. Proxy/fleet limits and production
  capacity must be tested and monitored.
- The exact fuzz gaps in `FUZZING.md` remain accepted test debt, not evidence
  that those entry points are unsafe or covered.

### Audit status

E19 documentation and internal source review are complete for handoff. The
system is not represented as independently audited or mainnet approved. The
external auditor should start at `AUDIT_PACKAGE.md`, record findings against
the pinned baseline, and update this retrospective and the readiness checklist
with immutable report links and explicit risk acceptance.
