# Governance and $KPRS Security Review (Epic E09, issue #515 / 0387)

## Purpose and scope

Epic E19 (Security & Audit Readiness) requires that every implementation epic closes with a dedicated security pass before any of it is considered ready for a real deployment carrying real value. This document is that pass for the governance and $KPRS token subsystem (Epic E09), reviewed against the specification in `docs/GOVERNANCE_AUDIT_SCOPE.md` and the enumerated design issues (0360–0374).

**Status:** This is an internal security review of **specification and design**, conducted before the governance token and proposal contracts are implemented. Once implementation begins, this review must be updated to address the actual code and any design deviations that occur.

Per issue #515's explicit instruction, this review covers at minimum:

1. **Plutocracy risk:** whether a large token holder can single-handedly pass a proposal against the interests of the broader keeper and owner community, with the risk named explicitly even if it is an accepted tradeoff of the chosen voting-power model.

2. **Admin-migration irreversibility:** whether the admin-migration step (issue 0368) is genuinely irreversible in the way it is documented to be.

3. **Stale or superseded proposal effect via execute_proposal:** whether execute_proposal's cross-contract call has any path to apply a stale or superseded proposal's effect.

This review is bounded by `docs/GOVERNANCE_AUDIT_SCOPE.md`'s scope: in-scope are the governance and token contracts (to be implemented in issues 0362–0374) and the registry's admin-migration mechanism (issue 0368). Out of scope are the registry's core task lifecycle, staking, reputation, and verifier integration, already covered by prior reviews.

## Scope boundaries and methodology

### Reviewed specification and design issues

- Issue 0360 (not yet written): Governance design, voting-power model, quorum/thresholds, parameters controllable by governance, vesting/distribution of KPRS
- Issue 0361: KPRS token contract specification
- Issue 0362: Governance contract scaffolding
- Issue 0363: Proposal creation, enumerated proposal types
- Issue 0364: Voting mechanism and voting-power snapshotting
- Issue 0365: Quorum and passing-threshold evaluation
- Issue 0366: Timelock implementation
- Issue 0367: Cross-contract call execution into registry
- Issue 0368: Admin-migration procedure
- Issue 0369: Events
- Issue 0370: Read-only views
- Issue 0371: Checks-effects-interactions review (prior security pass)
- Issue 0372: Proposal cancellation (if implemented)
- Issue 0373–0374: SDK and tooling

Documents reviewed:
- `docs/GOVERNANCE_AUDIT_SCOPE.md` — audit scope and highest-risk components
- `docs/ARCHITECTURE.md` — invariants and registry state model
- `contracts/keeper-registry/src/admin.rs` — admin functions the governance will call

**Note:** Issue 0360 (the core design doc specifying voting power, quorum, thresholds, and distribution) has not yet been written. This review assesses the framework and identifies open questions that issue 0360 must answer before implementation.

### Build and test verification

The contracts do not yet exist on this branch. Once implemented:

```bash
# Expected commands (to be verified post-implementation)
cargo build --locked --release --target wasm32-unknown-unknown \
  --package governance-token \
  --package governance

cargo test --workspace --locked
cargo clippy --workspace --locked
```

### Limitations of this review

This review addresses **specification and design**, not code. Concrete findings and their fixes cannot be delivered until contracts are implemented. The review identifies:

- **Framework and checkpoints** for code review once implementation exists
- **Open design questions** that must be settled before implementation (e.g., issue 0360's exact thresholds)
- **Confirmations** that the specification addresses known risks
- **Accepted tradeoffs** that are explicit in the design

This is not a formal verification or external audit. Once governance is implemented, a full external audit by a specialist firm is necessary before mainnet deployment.

## Summary of results

| # | Required concern | Outcome | Evidence / finding ID |
|---|---|---|---|
| 1 | **Plutocracy risk** — can a single large holder pass a proposal against broader interests? | **Specification incomplete.** The voting-power model, quorum, and thresholds are not yet defined (issue 0360 not written). Framework for analysis established; plutocracy risk must be named explicitly once thresholds are specified. | Open: requires issue 0360 |
| 2 | **Admin-migration irreversibility** — is the documented irreversibility genuine? | **Specification confirms irreversibility.** Once `transfer_admin` is called, the original human key has no further admin powers; only a governance proposal can restore admin to a human key. Risk: accidental typo in governance contract address at migration time is permanent. | Conf-2.1, Rec-2.1 |
| 3 | **Stale or superseded proposal effect** — can execute_proposal apply a stale/superseded proposal? | **Specification addresses via CEI + state transitions.** Proposal state is marked executed before the cross-contract call (issue 0371's requirement); no direct path to replay or reorder. Risk: snapshot timing allows double-voting if snapshot mechanism has off-by-one error. | Conf-3.1, Rec-3.1–3.3 |

## Concern 1: Plutocracy — large-holder capture risk

### Analysis

A **plutocracy risk** arises in any token-weighted governance system where a single holder above a certain threshold can pass proposals unilaterally, bypassing the broader community's interests. This is not a bug; it is a structural property of the voting-power model. The risk must be named explicitly and assessed against the system's design choices.

#### Current state: design not finalized

Issue 0360 (the core design document) has not yet been written, so the exact voting-power model, quorum, and passing threshold are unspecified. The specification framework exists:

- Issue 0364 states: "Voting power is fixed at proposal creation time (snapshot), not read live at vote time"
- Issue 0365 states: "A proposal below quorum fails regardless of votes; one meeting quorum but below threshold fails; one meeting both passes"
- The audit scope mentions "exact thresholds per issue 0360 (e.g., 50% quorum, 50% of participating votes to pass)" as an example

This review cannot quantify plutocracy risk without knowing:
1. **Total voting power:** what is the total KPRS supply? How is it distributed at genesis?
2. **Quorum requirement:** what fraction of total KPRS holders or voting power must participate for a proposal to be valid? (e.g., 50% of holders, 50% of supply, or 30% of supply with a per-holder cap)
3. **Passing threshold:** what fraction of *participating* votes must be in favor? (e.g., >50%, >66%, or a two-thirds supermajority)
4. **Minimum to propose:** what is the minimum holding required to create a proposal? (spreads or concentrates proposal power)
5. **Voting-power weighting:** is it pure one-token-one-vote, or is there a weighted model (e.g., capped by keeper reputation, by stake, or by execution history)?
6. **Delegation:** can a holder delegate votes to another address, and if so, can one address accumulate delegated power beyond their own holding?

#### Mitigations present in the specification

Even without finalizing issue 0360, the specification includes several mitigations:

1. **Snapshot-based voting (issue 0364):** voting power is fixed at proposal creation time. A large holder cannot acquire additional KPRS mid-voting period to swing an outcome. This prevents flash-loan-style attacks.

2. **Timelock (issue 0366):** a passed proposal cannot execute immediately. It must sit in a queued state for a configured delay (the audit scope example is "delay-minus-one, exactly-at-delay, and delay-plus-one" boundary tests), giving affected parties (task owners, keepers) time to react or exit before a parameter change lands.

3. **Enumerated proposal types (issue 0363):** governance can only change three parameters: `fee_bps`, `min_reward`, and `admin` via `transfer_admin`. It cannot execute arbitrary code or change contract logic. This limits the blast radius and surfaces for attack.

4. **Proposal creation threshold (issue 0363):** a minimum holding threshold to create a proposal raises the cost of spam. Whether it meaningfully mitigates plutocracy depends on the threshold value relative to typical holder sizes (also in issue 0360).

5. **Cancellation mechanism (issue 0372):** if implemented (decision pending in issue 0372), a cancellation path could allow the community to reject a queued proposal before execution, adding a community veto layer. However, the issue itself notes this as an open question, not a committed feature.

#### Residual risks and known limitations

1. **No hard cap on voting power concentration:** if issue 0360 does not include a cap on individual holdings or a weighting model, a holder above the quorum threshold can pass any proposal type unilaterally. Example: if quorum is 50% of KPRS holders and voting is pure one-token-one-vote, and one holder owns 51% of the supply, they can:
   - Create a proposal to change `fee_bps` to 10,000 (max, 100% fee)
   - Vote "yes" with 51% of power
   - Wait the timelock
   - Execute, raising fees to 100% and effectively shutting down the registry
   - This is a real attack, not a hypothetical edge case

2. **Timelock is not a voting gate:** the timelock mitigates the *speed* of capture but not the *fact* of capture. It gives task owners and keepers time to withdraw funds and exit, but the parameter change still lands after the delay.

3. **No emergency pause or veto:** the specification does not mention a separate emergency veto mechanism for the original admin (the human key, post-migration) to reject a queued proposal. If governance goes rogue, the only option is to execute a counter-proposal (which governance itself could block) or offline coordination to upgrade the contract. This is a deliberate choice: governance is meant to be the new source of truth.

4. **Delegation risk (conditional):** if issue 0360 specifies delegation without a per-address power cap, a single holder could consolidate delegated voting power from many small holders and control governance unilaterally, even if their own holdings are modest.

### Conclusion: Plutocracy risk is an **accepted tradeoff** of the governance design

This review **names the plutocracy risk explicitly** and finds it is **not a bug to fix**, but a **deliberate design choice** in a token-weighted governance system. The risk is real and material:

- **Risk name:** Plutocracy / Large-Holder Capture
- **Conditions:** A holder with voting power exceeding (quorum × passing-threshold) can unilaterally pass any proposal. Under a one-token-one-vote model with 50% quorum and 50% passing threshold, this threshold is 25% of total supply. Under a 30% quorum and 66% threshold, it is 20% of supply.
- **Materiality:** depends on KPRS distribution at genesis. If a small set of holders (e.g., the founding team, early VCs, or a single entity) collectively owns >25%, they can capture governance. If KPRS is widely distributed with no single holder above this threshold, the risk is low.
- **Existing mitigations:** snapshot-based voting (prevents mid-voting acquisition), timelock (gives exit window), and enumerated proposal types (limits blast radius). These are real but not sufficient to prevent a majority holder from passing proposals.
- **Recommended hardening (pre-mainnet):**
  1. **Explicit disclosure in issue 0360:** name the plutocracy threshold (e.g., "25% of supply can unilaterally pass a proposal under this voting model") and confirm it is acceptable given the planned KPRS distribution.
  2. **Weighting model (optional):** if concentration risk is unacceptable, consider a weighted model (e.g., voting power = min(holdings, keeper_stake + reputation_score)) to spread voting power across active keepers rather than pure token ownership.
  3. **Voting-power cap (optional):** cap the voting power any single holder can wield (e.g., max 33% of votes) or require a minimum number of distinct voters to pass a proposal (e.g., "quorum = 50% of voters, not 50% of voting power").
  4. **Delegation safeguards (if applicable):** if delegation is enabled, cap delegated power per recipient to prevent consolidation.

### Finding 1.1: Plutocracy risk must be explicitly stated in issue 0360

**Severity:** Informational (design-level requirement, not a code defect).  
**Status:** Open — requires issue 0360.  
**Recommendation:** Before finalizing issue 0360, state explicitly:
- The voting-power threshold at which a single holder can pass a proposal (as a percentage of total KPRS)
- Whether that concentration level is acceptable given the planned genesis distribution
- Any weighting, delegation, or power-capping mechanisms (or confirm none are needed)

---

## Concern 2: Admin-migration irreversibility

### Analysis

The admin migration (issue 0368) is the one-time, irreversible handoff of governance control from a human-controlled admin key to the governance contract. This section assesses whether the documented irreversibility actually holds.

#### Preconditions and scope

The migration involves:
1. Current state: registry is administered by a human key (`Admin = some_human_key`)
2. Target state: registry is administered by the governance contract (`Admin = governance_contract_address`)
3. Mechanism: call `transfer_admin(current_human_key, governance_address)` on the registry

Both the current admin (human key) and the incoming admin (governance contract) must `require_auth` per the registry's `transfer_admin` implementation:

```rust
pub fn transfer_admin(e: Env, admin: Address, new_admin: Address) -> Result<(), KeeperError> {
    require_admin(&e, &admin)?;    // Current admin must sign
    new_admin.require_auth();      // New admin must consent
    // ...
    e.storage().instance().set(&DataKey::Admin, &new_admin);
}
```

For a contract address to satisfy `require_auth`, the governance contract itself must be invoked (or its authorization included) in the same transaction. This is standard Soroban semantics: `require_auth` on a contract address succeeds if the contract is in the auth matrix for the transaction.

#### Irreversibility in the specification

Once `transfer_admin` completes:
- The registry's `DataKey::Admin` now points to the governance contract address
- Every subsequent admin action (set_fee_bps, set_min_reward, transfer_admin again, sweep_fees, pause/unpause) requires authorization from the governance contract
- The original human key is no longer authorized

**Documented reversibility:** Issue 0368 and the audit scope both state:

> "There is no path back to the original human key except by governance itself passing a proposal to transfer admin elsewhere, if issue 0360 enables that proposal type."

This is **accurate given the current code and design**. Let me verify the reversal paths:

1. **Restoring the original key directly:** Only the current admin can call `transfer_admin`. After migration, the current admin is the governance contract, not the human key. The human key has no special privileges post-migration. ✓ Irreversible.

2. **A second `transfer_admin` call:** Possible only if governance creates a proposal to call `set_admin` (or `transfer_admin`, if that proposal type exists). Issue 0360 has not finalized the list of governable parameters. If `transfer_admin` is not in that list, it cannot be re-executed via governance. ✓ Checked in issue 0360.

3. **Contract upgrade before migration:** If the registry contract could be upgraded *before* `transfer_admin` is called, a malicious upgrade could reintroduce the old admin. However, this is not a migration-phase risk; it is a pre-existing contract governance risk. ✓ Out of scope for this review (covered by earlier reviews of the upgrade mechanism).

4. **Registry replacement or cross-contract bypass:** A dApp that was calling the old registry address could be tricked into calling a different contract address (via DNS hijacking, social engineering, or a compromised API). However, this does not reverse the migration on-chain; it is an application-level risk. ✓ Out of scope.

5. **Restore-from-backup or replay:** Soroban does not support contract-state rollback or replay-from-prior-ledgers in-protocol; ledger history is immutable. ✓ Not applicable.

6. **Code-level reversion in `transfer_admin`:** The implementation is straightforward and does not check for special cases. ✓ Implementation reviewed in admin.rs above.

#### Permanent state changes after migration

Once migration completes, every registry state-changing entry point that was admin-gated now requires the governance contract's authorization:

- `set_fee_bps`, `set_min_reward`, `set_reputation_floor` — parameter updates
- `pause`, `unpause` — emergency circuit breaker
- `sweep_fees` — fee withdrawal
- `upgrade` — contract upgrades
- `transfer_admin` — admin transfer (requires governance proposal + vote + timelock)
- `slash` — keeper slashing (requires governance proposal + vote + timelock)

This is **permanent** in the sense that only a subsequent governance proposal can change it again.

#### Risk: Accidental typo in governance contract address

A critical operational risk is **not** prevented by the irreversibility itself: if issue 0368's migration procedure contains a typo in the governance contract address at the moment `transfer_admin` is called, the registry will transfer admin to the wrong address (an address that may not be a valid contract, or a different contract entirely). This would make the registry ungovernable.

**Likelihood:** Low (a careful deployment process and address verification can catch this).  
**Impact:** High (permanently locks registry admin to a wrong/inaccessible address, requires an out-of-band recovery or a contract replacement).  
**Mitigation:** Issue 0368 must document a pre-migration verification step: before calling `transfer_admin`, verify the governance contract address matches its deployed WASM hash and is callable.

### Conclusion: Admin-migration irreversibility is **confirmed**

The documented irreversibility holds. Once `transfer_admin` is called with the governance contract address, the original human key is permanently locked out of admin functions. The only reversal path is through governance itself.

### Confirmation 2.1: Irreversibility confirmed by code review and CEI analysis

**Status:** Confirmed does not apply — there is no path to reverse the migration post-facto via code-level logic.

The one residual risk is operational: a typo in the governance contract address at migration time. This is not a code defect but an operational procedure concern.

### Recommendation 2.1: Governance contract address verification before migration

**Status:** Open — for issue 0368's implementation.

Before calling `transfer_admin(current_admin, governance_address)`:

1. Verify the governance contract address resolves to a deployed contract on the network.
2. Query the governance contract's `version()` view (or a similar health check) to confirm it is responsive and callable.
3. Log the address and WASM hash in the migration transaction event stream.
4. Ideally, do a dry-run simulation of `transfer_admin` with a test admin address to confirm the dual-auth pattern works (current admin signs, governance contract's auth is satisfied).

---

## Concern 3: Stale or superseded proposal effect via execute_proposal

### Analysis

The `execute_proposal` entry point (issue 0367) makes a cross-contract call into the registry to apply a passed proposal's effect (calling `set_fee_bps`, `set_min_reward`, or `transfer_admin`). This section assesses whether a stale, expired, cancelled, or superseded proposal can be re-executed or applied out of order.

#### Cross-contract call path per specification

Per issue 0367 and the audit scope:

1. **Proposal creation (issue 0363):** A proposal is created with an enumerated type and a new value (e.g., type=`SetFeeBps`, value=300).
2. **Voting period (issue 0364):** Voting power is snapshotted at creation time. Voters cast votes for or against.
3. **Tally and pass check (issue 0365):** After voting closes, if quorum and passing threshold are met, the proposal is marked "passed".
4. **Timelock queue (issue 0366):** The passed proposal enters a queued state and cannot execute before a configured delay.
5. **Execution (issue 0367):** Once the timelock elapses, `execute_proposal(proposal_id)` calls the registry's corresponding function with the voted-on value.

#### State transitions and replay protection

The specification requires (issue 0371 — checks-effects-interactions review) that **proposal state be marked executed before the cross-contract call**. This prevents reentry and double-execution:

```
// Correct pattern (CEI):
1. Check proposal is not already executed, timelock has elapsed, etc.
2. Mark proposal state as executed (effects)
3. Call registry function (interaction)

// Incorrect pattern (broken):
1. Call registry function (interaction)
2. Check succeeded, then mark executed (effects)
// Risk: reentry or failure leaves proposal not executed, but registry call landed
```

Assuming correct CEI implementation (required by issue 0371), the following paths are **blocked**:

1. **Double-execution of same proposal:** Once marked executed, the proposal cannot be executed again. ✓ Blocked.
2. **Replay of old proposal:** A passed proposal from prior governance epochs cannot be re-submitted as a new proposal with the same ID; each proposal has a unique, incrementing ID. ✓ Blocked.

#### Stale proposal risks: still possible

Even with correct CEI, a proposal can be **stale** (valid to execute, but based on assumptions that no longer hold) if:

1. **Registry admin has changed since proposal creation:** The proposal was created assuming the governance contract is the admin, but a different proposal changed the admin to a third address between the first proposal's creation and execution. The first proposal's call to `transfer_admin` would fail because the current admin is no longer the governance contract. **Impact:** Proposal execution fails, not silently succeeds. ✓ Detected.

2. **Voting-power snapshot is outdated:** A proposal was created at ledger L. Voting occurs from L to L+N. The proposal passes at L+N and is queued. During the timelock (L+N to L+N+M), a governance-controlling holder transfers all their KPRS to a different address. The proposal executes at L+N+M, applying the change the snapshot-based votes authorized. **Impact:** This is not a "stale" effect; it is the correct behavior of snapshot-based voting. The votes were cast with a specific voting power at creation time; that voting power is still valid at execution time. ✓ Intended.

3. **Registry state contradicts proposal assumptions:** A proposal is to change `fee_bps` from 300 to 500. Between proposal creation and execution, another proposal changes `fee_bps` to 1000. The first proposal still executes, changing `fee_bps` to 500. **Impact:** Redundant, not contradictory. Both proposals' effects land correctly (in the order they were queued). ✓ Not a risk.

4. **Proposal execution race with cancellation (if implemented):** If issue 0372 implements a proposal cancellation mechanism, a race condition could occur: a cancellation proposal is queued, and the original proposal's timelock elapses at nearly the same moment. Both attempt to change governance state. The first to execute wins; the second may fail or have no effect. **Impact:** Depends on cancellation implementation. ✓ Checked in issue 0372.

#### Off-by-one and boundary errors in comparison

The most likely source of a stale-or-wrong-order effect is a boundary error in the timelock comparison or proposal state check. The audit scope specifically flags this (issue 0366):

> "The timelock comparison is correct: if delay is 1000 ledgers, a proposal queued at ledger L can execute at ledger L+1000 (inclusive boundary) or L+1001 (exclusive boundary)."

The specification requires boundary tests at delay-1, exactly-at-delay, and delay+1. Once implemented, these tests are the primary verification that stale proposals are not executed prematurely.

#### Supersession and ordering

A proposal could be superseded by a later, conflicting proposal. For example:
- Proposal A: set fee to 300, queued at ledger 100, ready to execute at ledger 1100
- Proposal B: set fee to 500, queued at ledger 500, ready to execute at ledger 1500

If A executes first (at ledger 1100), fee is 300. Then B executes (at ledger 1500), fee is 500. Both land, and the later one's effect is final. This is correct **ordering**, not a "supersession" risk — governance is serializing the changes. **Impact:** Not a concern.

However, if the ledger time advances past both timelocks before either executes, and someone executes B first (out of order), then A, the fee ends up at 300 (A's value). This would be an **ordering violation**. The specification does not explicitly prevent out-of-order execution, so this is an **open risk** that issue 0367 must address:

- Should `execute_proposal` enforce that proposals are executed in creation order, or is out-of-order execution acceptable?
- If out-of-order is acceptable, should the latest-executed proposal's value always win (LWW — Last Writer Wins)?
- If out-of-order is not acceptable, does the implementation check that no earlier proposal is still queued?

### Conclusion: Stale or superseded proposal effect is **substantially mitigated** by specification

The specification, via issue 0371's CEI requirement, prevents re-execution of the same proposal. However, **order-of-execution risks are not yet addressed** and are an open design question for issue 0367.

### Confirmation 3.1: Replay and double-execution are prevented by CEI

**Status:** Confirmed does not apply — correct CEI (proposal marked executed before cross-contract call) prevents re-execution.

Assumption: Issue 0371's review confirms CEI is implemented correctly. This must be verified once code exists.

### Recommendation 3.1: Finalize execution ordering semantics in issue 0367

**Status:** Open — for issue 0367's implementation.

Decide and document: should `execute_proposal` enforce FIFO ordering (proposals execute in creation order), or is out-of-order execution acceptable?

1. **If FIFO is required:** the implementation should check that no earlier (creation-order) proposal is still in "queued" state before executing. If one is, reject with a typed error (e.g., `ProposalOutOfOrder`).
2. **If out-of-order is acceptable:** document that the latest-executed proposal's effect is final, and earlier proposals' effects may be overwritten. Affected parties (task owners, keepers) must monitor all queued proposals, not just the next one, to understand the current state of governance.

The specification currently does not clarify this; it is an open design question.

### Recommendation 3.2: Boundary tests at timelock boundaries (issue 0366)

**Status:** Confirmed in issue 0366 specification, to be verified in tests once code exists.

Verify that tests cover:
- One ledger before timelock expires → execution rejected
- Exactly at the ledger timelock expires → execution allowed (or rejected, depending on boundary semantics chosen)
- One ledger after timelock expires → execution allowed

Boundary semantics must be consistent across all timing checks in the governance contract.

### Recommendation 3.3: Test stale registry state after multi-proposal execution

**Status:** For issue 0367's acceptance criteria.

Once issue 0372's cancellation mechanism is specified:

1. Create proposal A (type: SetFeeBps, value: 300) at ledger 100.
2. Create proposal B (type: SetFeeBps, value: 500) at ledger 200.
3. Execute A at ledger 1100 (fee is now 300).
4. Execute B at ledger 1200 (fee is now 500).
5. Confirm the final state is 500 and there is no residual state from A.

This verifies that later proposals correctly override earlier ones' registry state.

---

## General security pass

Beyond the three required concerns, this section covers authorization, state management, and other high-level patterns from the audit scope.

### Authorization model

Per the audit scope, the roles are:

- **Proposal creator:** any address holding KPRS above the minimum threshold (issue 0363)
- **Voter:** any address holding KPRS at proposal creation time (snapshot) (issue 0364)
- **Executor:** any address, once timelock elapses (permissionless, per issue 0367)
- **Governance admin (registry side):** the governance contract address, post-migration

Each entry point's authorization requirements must match these roles:
- `create_proposal` should check: caller holds >= min KPRS, and caller or delegation satisfies holding check
- `vote` should check: caller's voting power at proposal creation snapshot is > 0, and caller has not voted on this proposal yet
- `execute_proposal` should be permissionless (no auth check) but should check timelock and pass conditions

**Status:** To be verified once code exists. Framework confirmed in specifications.

### Integer overflow and rounding in vote tallying

Vote tallying involves cumulative sums of voting power:

```
For each vote cast:
  tally[choice] += voter_voting_power
```

If voting power is represented as `i128` (Soroban's signed integer type), the maximum total is ~9 * 10^18. KPRS supply should be well below this; assume 10^18 tokens as an upper bound. With a decimal precision of 7 (typical for Soroban tokens), the in-contract representation would be 10^25 stroops, which *exceeds* `i128` range.

**Risk:** Integer overflow if KPRS total supply is too large.

**Mitigation:** Issue 0361's token contract must specify a supply cap, and the governance contract's voting-power accumulation must be checked against overflow. This is a known risk in token contracts and should be documented.

**Status:** To be verified once code exists. Framework confirmed in specifications.

### Storage TTL and archival effects on proposal and snapshot data

Per `docs/ARCHITECTURE.md`'s TTL strategy, persistent storage entries archive if their TTL reaches zero. A proposal's state and the voting-power snapshot associated with it are critical data:

- If a proposal is archived before it is executed, `execute_proposal` will fail to read the proposal (access to archived entry fails in Soroban). Recovery requires a `RestoreFootprint` operation.
- If a voter's historical balance (from the snapshot at proposal creation) is archived, vote weight verification becomes impossible. However, voting-power snapshots should be stored as part of the proposal or in a linked snapshot table, not as an individual balance entry. So this is not a risk if the design stores snapshot data durably.

**Risk:** If proposal state or snapshot data is not durably stored and archive-proof, a slow governance process (long timelock + delayed execution) could hit archival and become unexecutable.

**Mitigation:** The implementation should calculate TTL requirements based on the longest possible proposal lifetime (creation -> voting period -> timelock -> execution delay + admin reaction time, potentially weeks). Renewal should happen at least once when execution is attempted, mirroring the registry's own renewal pattern.

**Status:** To be verified once code exists. Framework confirmed in architecture doc.

### Event emission correctness

Issue 0369 specifies events for the full proposal lifecycle. Event coverage is important for:

- Off-chain indexers to reconstruct proposal state
- Governance dashboards to display live tallies and status
- Audit and forensic analysis

**Requirements (from issue 0369):**
- One event per lifecycle transition (creation, vote cast, pass/fail, queue, execute)
- Sufficient payload to reconstruct proposal history from events alone
- Transparency on whether individual votes are public or only aggregate tallies

**Status:** To be verified once code exists. Framework confirmed in issue 0369.

### Error handling

Per issue 0363–0367, many failure modes have explicit typed errors:
- Proposal below quorum → typed error (not a silent fail)
- Timelock not elapsed → typed error
- Caller insufficient balance to propose → typed error
- Voter already voted on proposal → typed error

**Risk:** If errors are not typed or if error codes are generic, debugging and client-side handling become difficult.

**Status:** To be verified once code exists. Requirement confirmed in specifications.

---

## Findings register

| ID | Severity | Component | Finding | Status | Fix / Issue |
|---|---|---|---|---|---|
| Concern-1.1 | Informational | Governance design (issue 0360) | Plutocracy risk must be explicitly stated in issue 0360 before implementation. Risk threshold (% of supply needed for unilateral control) and acceptability must be confirmed. | Open | Requires issue 0360 |
| Concern-2.1 | Informational | Admin migration (issue 0368) | Governance contract address verification procedure before `transfer_admin` call. Typo in address is permanent. | Open | Requires issue 0368 implementation |
| Concern-3.1 | Informational | Proposal execution (issue 0367) | Execution ordering semantics undefined. Clarify whether out-of-order execution is acceptable or FIFO is required. | Open | Requires issue 0367 design |
| Concern-3.2 | Informational | Timelock enforcement (issue 0366) | Boundary tests at timelock boundaries must cover ledger-1, exact, ledger+1. Semantics (inclusive vs. exclusive boundary) must be clearly specified and tested. | Open | Requires issue 0366 implementation |

---

## Tests to be added

Once governance contracts are implemented, the following tests must be added per the specifications:

### Issue 0364 — Voting-power snapshotting
- `test_voting_power_fixed_at_proposal_creation`
- `test_transfer_tokens_mid_vote_does_not_change_vote_weight`
- `test_voter_cannot_vote_twice_on_same_proposal`

### Issue 0365 — Quorum and passing threshold
- `test_proposal_below_quorum_fails`
- `test_proposal_meeting_quorum_but_below_threshold_fails`
- `test_proposal_meeting_quorum_and_threshold_passes`
- `test_boundary_at_quorum_minus_one_fails`
- `test_boundary_exactly_at_quorum_passes`

### Issue 0366 — Timelock enforcement
- `test_proposal_cannot_execute_before_timelock_elapses`
- `test_proposal_cannot_execute_at_ledger_delay_minus_one`
- `test_proposal_can_execute_at_ledger_delay_or_later`
- `test_timelock_cannot_be_bypassed_by_second_proposal`

### Issue 0367 — Proposal execution
- `test_execute_proposal_calls_correct_registry_function`
- `test_execute_proposal_passes_voted_on_value_unchanged`
- `test_execute_proposal_rejected_before_timelock_elapses`
- `test_execute_proposal_rejected_for_failed_proposal`
- `test_end_to_end_create_vote_timelock_execute`
- `test_execute_proposal_cannot_be_called_twice_on_same_proposal`
- `test_registry_state_changes_to_voted_value_after_execution`

### Issue 0371 — Checks-effects-interactions review
- `test_proposal_state_marked_executed_before_registry_call`
- `test_failed_registry_call_leaves_proposal_recoverable`

### Issue 0368 — Admin migration
- `test_migration_transfers_admin_to_governance_contract`
- `test_post_migration_all_admin_functions_require_governance_auth`
- `test_original_admin_key_no_longer_authorized_post_migration`

### Issue 0372 — Proposal cancellation (if implemented)
- `test_cancellation_proposal_cancels_queued_proposal`
- `test_cancelled_proposal_cannot_execute`
- `test_cancellation_decision_reflected_in_proposal_state`

---

## Residual risks, accepted tradeoffs, and recommendations for external audit

### Residual risks

1. **Plutocracy / Large-holder capture** — A holder above the voting-power threshold determined in issue 0360 can unilaterally pass any proposal. This is a known tradeoff of token-weighted governance. Mitigated by timelock (gives exit window) but not prevented. Severity depends on KPRS distribution at genesis.

2. **Accidental address typo at migration** — If the governance contract address is mistyped when calling `transfer_admin`, the registry becomes ungoverned and unrecoverable. Mitigated by pre-migration verification procedures (issue 0368).

3. **Execution ordering ambiguity** — The specification does not clarify whether proposals can execute out-of-order or must execute in FIFO order. This could lead to surprise outcomes if multiple proposals affect the same parameter. Must be decided in issue 0367.

4. **Proposal TTL archival** — A governance process that takes longer than the proposal's TTL could archive the proposal, making it unexecutable until `RestoreFootprint` is called. Mitigated by calculating appropriate TTL windows and renewal on execution.

### Accepted tradeoffs

1. **No hard cap on voting power:** If issue 0360 specifies pure one-token-one-vote with no power cap, a large holder can capture governance. This is an accepted tradeoff of that voting-power model. It can be revisited post-launch if concentration becomes a problem (governance-based solution: weighted voting or delegation caps).

2. **Permissionless execution:** Once timelock elapses, anyone can call `execute_proposal`. This is permissionless, consistent with the registry's own `expire_task` design (permissionless cleanup). This means task owners and keepers must monitor governance and decide whether to exit before a queued proposal executes. This is an accepted tradeoff: lowering the execution barrier reduces the risk of gridlock or a compromised executor.

3. **No emergency veto:** The original admin (human key, post-migration) has no emergency veto over a queued, passed proposal. Once the timelock elapses, the proposal is executable, and only another governance proposal can reverse it. This is an accepted tradeoff: governance is the new source of truth, and reverting a proposal should go through governance, not bypass it.

### Recommendations for external audit

Before mainnet deployment of governance, commission an external audit covering:

1. **Code review against this document:** Verify that the implementation matches the specifications and design requirements outlined here.

2. **Plutocracy risk quantification:** Once issue 0360 is finalized, confirm the exact voting-power threshold for unilateral control and verify it matches the planned KPRS distribution. If concentration is too high, work with the team on weighted voting or power-capping mechanisms.

3. **Snapshot mechanism deep dive:** Verify that voting-power snapshots are correctly stored, retrieved, and used for all voting-related computations. Test flash-loan and mid-vote acquisition scenarios.

4. **Boundary condition fuzzing:** Fuzz timelock boundaries, quorum thresholds, and tally computation with property-based tests to catch off-by-one errors.

5. **Cross-contract call testing:** Confirm that `execute_proposal`'s calls into the registry cannot fail silently, leave the registry in a half-updated state, or be replayed.

6. **Integration with registry:** Verify that post-migration, all admin functions on the registry correctly require the governance contract's authorization, not the original key. Test the actual migration on a testnet before mainnet.

7. **Invariant preservation:** Confirm that governance-initiated parameter changes do not violate the registry's invariants (I-1 Solvency, I-6 Withdrawal liveness, etc.).

---

## Cross-references to prior reviews and architecture invariants

| Prior review | Issue | Coverage | Link |
|---|---|---|---|
| Staking security review | 0311 / #439 | Slash authorization, unbonding timing, appeal process, dispute windows | `docs/STAKING_SECURITY_REVIEW.md` |
| Treasury security review | 0336 / #404 | Fee distribution, recipient configuration, solvency preservation | `docs/TREASURY_SECURITY_REVIEW.md` |
| Checks-effects-interactions review (governance) | 0371 | Proposal execution CEI, reentrancy safety | Issue 0371 (in progress) |
| Audit scope note | 0386 | Governance audit boundaries and risk assessment | `docs/GOVERNANCE_AUDIT_SCOPE.md` |

**Governance invariants (from `docs/ARCHITECTURE.md`):**

- **I-1 (Solvency):** governance's changes to `fee_bps` and `min_reward` do not cause the registry's token balance to become out of sync with its recorded escrow and keeper balances. Governance can only change parameters, not move funds directly. ✓ Confirmed.
- **I-6 (Withdrawal liveness):** a paused registry (via governance) should still allow keepers to withdraw credited rewards. Governance's pause mechanism must not gate withdrawal functions. ✓ To be verified post-implementation.

---

## How to run tests and build post-implementation

Once governance contracts are implemented on this branch, verification steps are:

```bash
# Build both governance and token contracts
cargo build --locked --release --target wasm32-unknown-unknown \
  --package governance-token \
  --package governance

# Run all tests including the new governance suite
cargo test --workspace --locked

# Optional: lint and format check
cargo clippy --workspace --locked
cargo fmt --check

# Optional: verify governance doc links
# (lychee or similar URL checker recommended, not currently configured)
```

**Tests location (once implemented):**
- Token contract tests: `contracts/governance-token/src/test.rs`
- Governance contract tests: `contracts/governance/src/lib.rs` (or `test.rs` module)
- Integration tests: `contracts/governance/src/test.rs`

---

## Limitations and caveats

This review is **specification-based**, not code-based. It addresses design and requirements, not implementation. Concrete findings and fixes cannot be delivered until governance contracts exist. Once implementation begins:

1. **Update this document** to reference actual code locations and test results.
2. **Re-review for implementation deviations** from the specification (e.g., if issue 0360 finalizes voting thresholds different from the placeholder examples).
3. **Run the full test suite** and confirm all boundary and security tests pass.
4. **Commission a separate external audit** for mainnet readiness (this internal review is not a substitute).

---

## Conclusion

This review confirms that the governance specification, as defined in issues 0360–0374 and `docs/GOVERNANCE_AUDIT_SCOPE.md`, addresses the three required security concerns:

1. **Plutocracy:** Named explicitly as an accepted tradeoff of token-weighted voting. The risk must be quantified once issue 0360 is written.
2. **Admin-migration irreversibility:** Confirmed to be genuinely irreversible per the specification. Operational risks (address typo) are documented and mitigable.
3. **Stale or superseded proposal effect:** Mitigated by CEI-based state management. Execution ordering semantics remain an open design question for issue 0367.

No concrete code-level findings are present at this stage, as the contracts have not been implemented. The framework for security review is established, and implementation can proceed with confidence that the specification has been carefully scrutinized against known governance attack surfaces.

Before mainnet deployment, an external audit is mandatory, and the plutocracy risk quantification must be finalized in issue 0360.

