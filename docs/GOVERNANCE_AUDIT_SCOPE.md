# Governance and Token Audit Scope

This document defines the scope for a future external audit of the governance and KPRS token subsystem before mainnet consideration. It is written ahead of an audit being commissioned, to give an auditor precise boundaries rather than a vague "review the governance code" instruction. This is the governance equivalent of the pattern issue 0139 established for the verifier epic.

**Status:** This is a scope note for **unshipped work**. The governance token and proposal contracts do not yet exist in released form on mainnet or testnet. See the epic index in [`.github/backlog/README.md`](../.github/backlog/README.md) for the full roadmap and current implementation status.

---

## Purpose and context

The Soroban Keeper Network is currently governed by a single admin key, creating a centralization risk for critical parameters:

- Fee basis points (`fee_bps`)
- Minimum reward (`min_reward`)
- Admin key itself (`transfer_admin`)
- Treasury recipient configuration and distribution splits (if epic E08 lands)

Epic E09 introduces a governance token (KPRS) and a on-chain governance process to move this control to token holders. The scope below defines what a future auditor must cover when commissioned to review this system before mainnet deployment.

---

## In scope (primary)

An external auditor must review the following contracts in their entirety:

### KPRS Token Contract

**Path:** `contracts/governance-token/` (not yet implemented)  
**Purpose:** Standard fungible token for governance participation and keeper rewards (subject to issue 0360's final design decisions on distribution and vesting).

**Auditor must cover:**

- Token supply mechanics: total supply, minting rules (if any), burning rules (if any), initial distribution.
- Transfer and approval semantics: standard ERC-20-like interface, reentrancy safeguards, approval callbacks.
- Authorization model: who can mint, burn, transfer admin, upgrade the contract.
- If vesting is implemented, on-chain enforcement of vesting schedules (transfers of unvested tokens are rejected, not merely documented).
- Checkpoint or voting-power snapshot support, if the design uses it for governance voting.

**Primary artifacts:**

- `contracts/governance-token/src/lib.rs` — token contract implementation
- `contracts/governance-token/src/test.rs` — unit and integration tests
- Issue 0360 (design doc) for the enumerated design decisions on supply, distribution, and vesting

### Governance Contract

**Path:** `contracts/governance/` (not yet implemented)  
**Purpose:** Proposal creation, voting, timelock, and execution of parameter changes to the registry.

**Auditor must cover:**

- **Proposal creation:** only the closed list of governable parameter types (fee_bps, min_reward, admin transfer) are allowed; arbitrary calls are rejected. Minimum holding threshold to create a proposal (from issue 0360) is enforced. Enumerated proposal types are defined and tested.

- **Voting mechanism:** voting power is fixed at proposal creation time (snapshot), not read live at vote time, preventing a voter from acquiring additional tokens mid-vote to retroactively change their weight. Voter cannot vote twice on the same proposal. Correct tally computation. Voting period enforcement.

- **Quorum and passing threshold:** exact thresholds per issue 0360 (e.g., 50% quorum, 50% of participating votes to pass). If a proposal does not reach quorum or fails the threshold, it is rejected before execution. Boundary tests at threshold-1, exactly-threshold, and threshold+1.

- **Timelock:** a passed proposal enters a queued state and cannot execute before the configured delay elapses. Queued state and remaining delay are queryable. Boundary tests at delay-1, exactly-delay, and delay+1. Timelock cannot be bypassed (e.g., a second proposal cannot fast-track the first).

- **Proposal execution:** cross-contract call into the registry to apply the voted-on parameter change. Execution is rejected before timelock elapses and for proposals that did not pass, with distinct typed errors. State transitions are properly ordered (checks-effects-interactions per issue 0371).

- **Proposal cancellation:** any cancellation mechanism (if issue 0360 specifies one), the conditions under which a proposal can be cancelled, and whether cancellation blocks execution of an already-passed proposal.

- **Authorization:** who can call each entry point (create_proposal, vote, execute_proposal), and how authorization is checked (signature auth, contract auth, role-based).

**Primary artifacts:**

- `contracts/governance/src/lib.rs` — governance contract implementation
- `contracts/governance/src/test.rs` — unit and integration tests, particularly the end-to-end flow (create → vote → timelock → execute)
- Issue 0360 (design doc) for design decisions on voting power, quorum, thresholds, timelock delay, and proposal types
- Issue 0363 (proposal creation) for the enumerated parameter types
- Issue 0364 (voting) for voting-power snapshotting
- Issue 0366 (timelock) for delay enforcement
- Issue 0367 (execution) for cross-contract call implementation
- Issue 0371 (checks-effects-interactions review) for execution-path CEI analysis

---

## Affected but out of primary scope

The following components are affected by governance but are **not primary audit targets** for this engagement, with one exception noted below:

### Keeper Registry Contract

**Why out of primary scope:** The registry (`contracts/keeper-registry/`) and its existing surfaces (task lifecycle, escrow, fee logic, staking, reputation) are already subject to their own audit scope (issue 0139 for the verifier integration, the original `docs/AUDIT_SCOPE.md` for the core registry). This audit focuses on governance's view of the registry.

**Exception — Admin migration (in scope for governance):**  
The registry's `transfer_admin` function and the one-time migration of admin control from the current human key to the governance contract address must be reviewed as part of this audit, since it is the gateway transaction that gives governance teeth. Specific artifacts:

- `contracts/keeper-registry/src/admin.rs` — the `transfer_admin` implementation (dual-auth pattern, contract-auth handling)
- Issue 0368 (admin migration) — the documented, step-by-step procedure for the actual migration on a live network
- A test on a local network that performs the migration and confirms all previously admin-gated registry functions now require the governance contract's authorization, not the original admin's

**Everything else in the registry** (task lifecycle, fee distribution, staking, reputation, verifier integration) is out of scope for this engagement. Any interactions beyond the specific admin-transfer mechanism should be evaluated by the auditor at their discretion, but are not required.

### Treasury Contract

**Why out of scope:** If epic E08 (fee routing) ships a separate treasury contract, its own admin and distribution logic are outside this scope unless the governance design from issue 0360 makes the treasury a governance parameter (e.g., treasury recipient shares). If that is the case, only the governance side (how a proposal changes a treasury parameter) is in scope; the treasury's own accounting is not.

### Other components

**Out of scope:**

- **Verifier contracts** (epic E04) — covered by a separate scope note (issue 0139, `docs/AUDIT_SCOPE.md`).
- **Staking and reputation** (epics E06, E07) — covered by the original `docs/AUDIT_SCOPE.md`.
- **Off-chain infrastructure** — keeper bot v2 (epic E15), indexer (epic E14), CLI (epic E10), dashboard (epic E11), examples, and deployment scripts are out of scope.
- **Soroban host and SDK behavior** — assumptions about ledger time, invocation limits, and token transfer semantics are out of scope; the audit should document assumptions rather than probe the host.
- **Third-party dependencies** — Soroban SDK version pinning and supply-chain risk are covered by the project's broader security review (issue 0517 and beyond), not this engagement.

---

## Highest-risk components

### Proposal Execution's Cross-Contract Call into the Registry

**Why high-risk:**  
The `execute_proposal` entry point calls `set_fee_bps`, `set_min_reward`, or `transfer_admin` on the registry using the governance contract's authorization. This is the moment governance's decision becomes effective. A vulnerability here could allow:

- An unapproved proposal to execute (replayable, stale, or out-of-order calls).
- A passed proposal to execute twice, crediting a change twice and corrupting registry state.
- A proposal to execute despite a re-entrant call from the registry failing partway through, leaving governance thinking a change landed when it did not.

**What the auditor should verify:**

- The proposal state transition (marked as executed or consumed) happens **strictly before** the cross-contract call into the registry via `require_auth` or `try_invoke_contract`. This prevents reentry and double-execution (checks-effects-interactions).
- The call uses the correct registry function signature and passes the exact voted-on value; a typo or wrong variable could apply the wrong change.
- If `try_invoke_contract` is used (non-fatal failure path), the proposal's state is handled correctly if the registry call fails: does the proposal remain executable (risk of later re-attempt), or is it marked consumed despite the change not landing (risk of silent loss)?
- Authorization is handled correctly: the registry's `require_auth` on its admin functions must accept the governance contract's own address as a valid admin after the migration (issue 0368), not still expect the original human key.

**See also:** Issue 0371 (checks-effects-interactions review).

### Voting-Power Snapshotting

**Why high-risk:**  
Voting power determines who can propose and how much weight each vote carries. A vulnerability here could allow:

- A voter to acquire additional tokens mid-vote and cast votes weighted by their new balance (double-voting effect).
- An off-by-one error in snapshot timing (voting at block N but snapshot taken at block N-1) to exclude eligible voters or include ineligible ones.
- Live-balance reads instead of snapshots, making a proposal's outcome dependent on token flows during the voting period (auction or flash-loan attacks).

**What the auditor should verify:**

- Voting power is fixed at proposal creation time and stored as part of the proposal or in a linked snapshot structure, not computed live when votes are cast.
- A test transfers tokens to a voter (or from them) mid-vote and confirms their already-cast vote weight does not change and future votes cannot exceed their snapshot balance.
- Boundary tests confirm the exact ledger/timestamp at which the snapshot is taken (e.g., proposal creation block, proposal-open block, or first-vote block).
- The snapshot mechanism is consistent across all voting-related queries (cumulative tally, individual vote weight, quorum checks).

**See also:** Issue 0364 (voting mechanism).

### Timelock Boundary Correctness

**Why high-risk:**  
The timelock delay between a proposal passing and becoming executable is a critical affordance: it gives task owners and keepers time to react to a parameter change before it lands. A boundary error could allow:

- A proposal to execute before the delay elapses (off-by-one error, wrong comparison operator, ledger vs. timestamp confusion).
- The delay to be bypassed (a second proposal, a manual registry call, or a cancellation-and-recreate cycle).
- Ambiguity in boundary semantics (is the delay inclusive or exclusive at the boundary ledger, confusing callers or auditors).

**What the auditor should verify:**

- The timelock comparison is correct: if delay is 1000 ledgers, a proposal queued at ledger L can execute at ledger L+1000 (inclusive boundary) or L+1001 (exclusive boundary). State the convention and verify it with tests at L+999, exactly L+1000 or L+1001, and L+1001 or L+1002.
- Timelock cannot be bypassed by any governance action: cancelling and re-creating a proposal starts a new delay; re-voting does not reset the clock; a separate proposal does not affect an existing proposal's timelock.
- If the timelock uses ledger-sequence comparisons, verify the comparison does not confuse past and future (e.g., `current_ledger <= proposal_queue_ledger + delay` will always be true for old proposals and block execution forever).
- The queued state and remaining delay are queryable so affected parties can see exactly how long to wait.

**See also:** Issue 0366 (timelock implementation).

---

## Trust assumptions and system properties

The auditor should verify the governance system operates correctly under the following assumptions and should confirm each one is stated in the code or design:

### Roles and authorization

- **Governance admin:** the governance contract's own address, set once via `transfer_admin(governance_address)` on the registry (issue 0368).
- **Token holders:** anyone holding KPRS tokens above the minimum proposal threshold can create a proposal.
- **Voters:** anyone holding KPRS tokens at the proposal creation snapshot can vote.
- **Executor:** anyone can call `execute_proposal` once the timelock elapses (permissionless, consistent with `expire_task`'s design).

### Key properties

- **Irreversibility of admin migration:** once `transfer_admin` is called, the governance contract becomes the registry's admin. There is no path back to the original human key except by governance itself passing a proposal to transfer admin elsewhere (if issue 0360 enables that proposal type).

- **One-token-one-vote (or weighted model, per issue 0360):** the governance system uses voting power based on KPRS holdings at snapshot time. If a weighted model is used (e.g., by keeper reputation, by stake, or by keeper execution history), the exact weighting formula and its interaction with the snapshot should be documented and verified.

- **Ledger-based delays:** both the lock window in the registry and the governance timelock use ledger sequence for boundary checks, not unix timestamps. This is immune to network-wide clock adjustments or timestamp ordering attacks. Verify this assumption is consistent across both contracts.

- **Soroban host semantics:** the audit should document its assumptions about Soroban's `try_invoke_contract` behavior (when it fails vs. panics, how re-entrancy is handled, resource budgeting), `require_auth` (what it accepts as a valid signer when the auth target is a contract), and ledger time semantics (monotonicity, availability, precision).

### Linked invariants (from `docs/ARCHITECTURE.md`)

Governance introduces new state but should not break the existing money invariants of the registry. The auditor should verify:

- **I-1 (Solvency):** governance's changes to `fee_bps` and `min_reward` do not cause the registry's token balance to become out of sync with its recorded escrow and keeper balances.
- **I-6 (Withdrawal liveness):** a paused registry (via governance) should still allow keepers to withdraw credited rewards (existing behavior, but verify governance's pause interaction does not introduce a loophole).

**See also:** [`docs/ARCHITECTURE.md`](ARCHITECTURE.md) for the full list of invariants and their definitions.

---

## Prior security reviews

The governance epic completed a reentrancy-focused security review (issue 0371) before the full security review (issue 0387) that precedes mainnet consideration. An auditor should be aware of these prior reviews and their findings; this scope note does not duplicate them but cross-references them for context:

| Review | Issue | Coverage | Status |
|--------|-------|----------|--------|
| Checks-Effects-Interactions review | [0371](../.github/backlog/issues/0371-governance-reentrancy-review.md) | Proposal execution's cross-contract call: CEI ordering, reentrance safety, state consistency. | In progress (E09 wave 4) |
| Full security review (pre-mainnet) | [0387](../.github/backlog/issues/0387-governance-security-review.md) | Complete review scoped per this document, including plutocracy risk analysis and admin-migration irreversibility. | Pending (E09 wave 4) |

For the verifier integration (epic E04), which has its own separate scope note:

| Review | Issue | Coverage |
|--------|-------|----------|
| Verifier audit scope | [0139](../.github/backlog/issues/0139-verifier-audit-scope-note.md) | Verifier interface, reference implementations, failure semantics, security considerations. Documented in [`docs/AUDIT_SCOPE.md`](AUDIT_SCOPE.md). |

**Findings from these reviews are not restated here.** An external auditor should read issue 0371 and 0387 (once available) to understand what was already covered and any open recommendations.

---

## Build, test, and verification

### Prerequisites

The auditor should have:

- Rust stable (≥ 1.78) with the `wasm32-unknown-unknown` target
- Soroban CLI (≥ 22.x)
- Node.js ≥ 18 LTS (for example and integration tests)

See [`CONTRIBUTING.md`](../CONTRIBUTING.md) for full setup.

### Building

```bash
# Build all contracts, including governance (once implemented)
make build

# Build just the governance token and proposal contracts
cargo build --locked --release --target wasm32-unknown-unknown \
  --package governance-token \
  --package governance
```

### Running tests

```bash
# Run all tests
cargo test --workspace --locked

# Run only governance tests
cargo test --package governance --locked
cargo test --package governance-token --locked

# Run with logging (optional)
RUST_LOG=debug cargo test --workspace --locked -- --nocapture
```

### Test location

- Unit and integration tests for the governance contract: `contracts/governance/src/test.rs`
- Unit and integration tests for the token contract: `contracts/governance-token/src/test.rs`
- E2E flow test (create → vote → timelock → execute): `contracts/governance/src/test.rs`

### Documentation verification

Links in this document can be verified locally:

```bash
# Check that relative links point to existing files (requires lychee or similar)
# No automated link-check is currently configured in this repo.
# Manual verification is recommended: spot-check a few links against the file tree.
```

---

## Open questions or known gaps

- **Governance participation incentives:** Issue 0360 should specify whether governance participation is incentivized (e.g., via KPRS inflation, keeper reward distribution, or a separate treasury). If so, how the incentive interacts with the voting-power model should be reviewed.

- **Proposal veto or emergency pause:** If issue 0360 specifies an emergency pause or veto mechanism (e.g., multisig override, timelock extension), its authorization and correctness should be reviewed. If not, this is out of scope.

- **Cross-contract upgrade compatibility:** If the governance contract or token can be upgraded, the contract's upgrade mechanism (if any) and its interaction with voting power and active proposals should be reviewed.

- **Testnet dry-run results:** Once the governance contracts deploy to testnet (planned per issue 0388), the auditor should observe and confirm actual on-chain behavior matches expected behavior, particularly timelock enforcement and cross-contract calls.

---

## Requested audit deliverables

Consistent with the pattern from prior epics (issue 0139), the external auditor should provide:

1. **Detailed findings report**, organized by severity (Critical, High, Medium, Low, Informational), with clear reproduction steps or code citations for each finding.

2. **Risk assessment** covering the three named highest-risk components (proposal execution, voting-power snapshotting, timelock boundary) and any additional risks the auditor identifies.

3. **Plutocracy risk assessment** (from issue 0387): an explicit statement of whether a large token holder can single-handedly pass a proposal against the broader keeper and owner community, and whether this is an accepted tradeoff of the governance design.

4. **Fix-review pass** (if any findings are reported): once fixes are proposed, a re-review of the changed code to confirm the fixes are correct and complete.

5. **Sign-off statement:** a summary statement of the auditor's confidence in the system's readiness for mainnet deployment, including any conditions, caveats, or recommended monitoring.

---

## Maintaining this document

Update this document as governance development progresses:

- Once contracts are implemented, verify contract paths and test locations match what is in the repository.
- Once issue 0371 (reentrancy review) and 0387 (full security review) are complete, update the "Prior security reviews" section with actual findings or confirmations.
- Add any additional high-risk components identified during development.
- If issue 0360 specifies features not covered here (e.g., proposal veto, upgrades, cross-governance interactions), extend the "In scope" and "Highest-risk components" sections.
- Once a testnet dry-run (issue 0388) completes, note the results and any adjustments to scope based on observed behavior.
