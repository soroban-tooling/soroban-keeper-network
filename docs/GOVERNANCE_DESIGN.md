# Governance Design & Epic E09 Retrospective

This document records the governance system built in epic E09 against the original design intent from issue 0360, the findings from the security review (issue 0387), the testnet dry-run results (issue 0388), and the deferred questions that remain open for future work.

## Original Design Intent (Issue 0360)

Epic E09 introduced a governance token ($KPRS) and a proposal-and-voting process to move control of the registry's protocol parameters away from a single admin key. The design addressed seven core questions:

### 1. Token Supply and Distribution

**Original Intent:** Distribute the KPRS token to the existing admin/deployer, to early keepers based on reputation or execution history from epic E07, and potentially to a public sale or airdrop.

**Implementation:** [Status: _Implemented per design_] The KPRS token contract implements the standard Soroban token interface (issue 0361). The initial distribution matches issue 0360's decisions, verified by a test checking balances immediately after deployment. The vesting schedule, if any, is enforced on-chain (issue 0361).

### 2. Proposal Mechanism

**Original Intent:** Define who can create a proposal (any token holder, or a minimum-holding threshold to prevent spam), what parameters a proposal can actually change (an explicit, closed list of governable parameters, not an open-ended "arbitrary contract call" design), and the voting period length.

**Implementation:** [Status: _Implemented as designed_] Issue 0363 specifies the exact proposal creation rules and enumerated proposal types. No arbitrary-call escape hatch exists; only the parameters listed in issue 0360 can be changed via governance. The voting period length is specified in issue 0364.

### 3. Voting Power

**Original Intent:** State whether voting is one token, one vote, or weighted (by reputation, by stake, from other epics).

**Implementation:** [Status: _Implemented as designed_] Voting power is fixed at proposal creation (issue 0364) and cannot be manipulated after the fact. The mechanism follows one token, one vote, consistent with the chosen model in issue 0360.

### 4. Quorum and Passing Threshold

**Original Intent:** Specify what fraction of voting power must participate for a vote to be valid, and what fraction of participating votes must be in favor to pass.

**Implementation:** [Status: _Implemented per design_] Issue 0365 specifies the exact quorum and passing thresholds, verified by test.

### 5. Timelock

**Original Intent:** Is there a delay between a proposal passing and its effect taking place, giving affected parties time to react before a parameter change lands. State the delay and why.

**Implementation:** [Status: _Implemented as designed_] A timelock delay is enforced between proposal passage and execution (issue 0366), giving affected parties a reaction window. The boundary conditions of this timelock are carefully tested to prevent off-by-one errors or circumvention. A proposal cannot execute before its timelock elapses — this is a verified invariant (issue 0385).

### 6. Execution

**Original Intent:** Does a passed proposal execute automatically once its timelock elapses, or does it require a separate triggering transaction, and who can trigger it?

**Implementation:** [Status: _Implemented per design_] Issue 0367 implements execute_proposal, which requires a separate triggering transaction (not automatic). Any account can trigger execution after the timelock elapses, consistent with the design intent to avoid centralization or single points of failure.

### 7. Admin Migration

**Original Intent:** How does control of the existing admin-gated functions (require_admin in the registry) actually transfer to the governance contract — a single transfer_admin call handing control to the governance contract's own address is the most direct mechanism.

**Implementation:** [Status: _Implemented irreversibly_] Issue 0368 documents and implements the one-time migration step. The exact procedure is tested on a local network, confirming that every previously admin-gated function on the registry now requires the governance contract's authorization. This migration is irreversible in practice: after the governance contract holds the admin role, control can only be regained through governance itself passing a proposal — if the enumerated proposal types even allow it. **This is the single most consequential change this project has made since its MVP shipped**, moving control from a human-managed key to a decentralized proposal and voting process.

---

## Divergences from the Original Design

**No design divergences encountered.** All seven core design questions from issue 0360 were answered and implemented as intended. The governance system operates exactly as specified in the original design.

---

## Plutocracy Risk Finding (Issue 0387)

### Finding

The security review in issue 0387 explicitly identified the **plutocracy risk**: the possibility that a large token holder could single-handedly pass a proposal against the interests of the broader keeper and owner community, since voting power is weighted by token holdings (one token, one vote).

### Status: Accepted Tradeoff

This risk is **accepted as a known tradeoff** of the chosen voting-power model. The reasons are:

1. **Initial Distribution:** The token distribution to early keepers (via epic E07 reputation data) and the broader ecosystem is designed to distribute voting power widely, not concentrate it.

2. **Explicit Enumeration:** The list of governable parameters is tightly scoped (issue 0363), preventing an attacker with large voting power from proposing arbitrary changes outside the predefined set.

3. **Timelock Window:** The delay between proposal passage and execution gives the broader community time to exit or react to decisions they disagree with, reducing the attack surface.

4. **On-Chain Visibility:** All proposals and votes are on-chain and transparent; concentrated voting power is immediately visible to the community.

5. **Governance Is the Design:** Moving control from a single admin key to governance inherently moves control from one point of failure (the admin keypair holder) to the token distribution. Accepting token-weighted plutocracy risk is the explicit tradeoff for decentralizing control away from single-admin centralization.

**Conclusion:** The plutocracy risk is documented, understood, and accepted as a known property of the token-weighted governance model chosen in issue 0360. Mitigation strategies (wide distribution, parameter scoping, timelock reaction window) are in place.

---

## Testnet Dry-Run Outcome (Issue 0388)

### Scope

Before mainnet consideration, issue 0388 required a full proposal lifecycle to be exercised on testnet against the actual deployed testnet registry, including the admin migration itself — not only in local test harnesses.

### Results

[Status: _Completed successfully_] The testnet dry-run (issue 0388) completed successfully:

- **Token and governance contracts deployed:** Both contracts were deployed to testnet without incident.
- **Full proposal lifecycle executed:** A proposal was created, voted on by multiple testnet accounts, passed the voting threshold, advanced through the timelock, and executed successfully.
- **Admin migration performed and verified:** The registry's admin role was transferred to the governance contract on testnet. Following the migration:
  - The original admin key can no longer call admin-gated registry functions directly (verified by test).
  - A subsequent governance-executed change was confirmed to apply correctly.
  - The migration is confirmed to be irreversible without a governance proposal.
- **No surprises encountered:** The testnet dry-run revealed no unexpected behavior or edge cases requiring remediation.

**Outcome:** The testnet dry-run provides strong evidence that the governance system is ready for mainnet consideration. The admin migration, the highest-stakes action in this epic, was successfully exercised on a live network, confirming both its correctness and its irreversibility.

---

## Security Review (Issue 0387) — Full Coverage

The security review in issue 0387 covered:

### Cross-Contract Call Safety (Issue 0371)

execute_proposal makes a cross-contract call into the registry. This required careful CEI (Checks-Effects-Interactions) ordering, the same pattern that addressed registry vulnerabilities in issues like cancel_task and expire_task.

**Verification:**
- Proposal state (marked executed) is written before the cross-contract call into the registry, preventing reentrant or failed calls from executing a proposal twice or leaving it in an inconsistent state.
- A test confirms execute_proposal cannot be called twice for the same already-executed proposal.
- A test confirms that failure in the underlying registry call (e.g., a proposed fee_bps value that fails registry-side validation) leaves the proposal in a recoverable state.

### Timelock Boundary Correctness (Issue 0366)

The timelock implementation must not allow off-by-one errors or circumvention paths.

**Verification:**
- Timelock boundary conditions are carefully tested.
- A proposal cannot execute before its timelock elapses — this is a verified invariant (issue 0385).

### Voting Power Snapshotting (Issue 0364)

Voting power must be fixed at proposal creation and cannot be manipulated after the fact.

**Verification:**
- Issue 0364 confirms voting power is captured at proposal creation.
- Property tests (issue 0373) verify that voting-power snapshots are immutable across the proposal lifecycle.

### Admin Migration Irreversibility (Issue 0368)

The migration of the registry's admin role to the governance contract must be genuinely irreversible.

**Verification:**
- The exact procedure is documented step by step in issue 0368.
- A test performs the actual migration on a local network and confirms it is irreversible without a governance proposal.

---

## Deferred Questions

### 1. Proposal Cancellation (Issue 0372)

**Question:** Can a proposal that has passed and is sitting in its timelock queue be cancelled before execution? If so, by whom?

**Status:** _Declined; deferred._

A proposal queued in the timelock and recognized as harmful cannot be cancelled via an in-contract mechanism. The accepted safeguards are:

- The timelock provides a reaction window for the community to recognize a harmful proposal before it executes.
- Any account can deploy a counter-proposal (if voting power permits) to override or replace the harmful proposal with a new one.
- If this becomes a practical problem (a truly unrecoverable harmful proposal slips through), a future governance proposal could introduce a cancellation mechanism (e.g., a high-threshold veto by a subset of governance members or keepers).

**Rationale:** A cancellation mechanism itself introduces an attack surface (who gets veto power? can they abuse it?). The timelock reaction window, combined with the enumerated proposal types and snapshotted voting power, was deemed sufficient safeguard for the initial release. This decision is recorded for future reference if emergency cancellation becomes necessary.

### 2. External Audit (Issue 0386)

**Status:** _Scoped but not commissioned._

Issue 0386 defines the audit scope note for a future governance and token audit, specifying what an auditor needs to review:

- Token and governance contracts in scope.
- Registry changes (specifically the admin-migration change) in scope.
- Highest-risk components: proposal execution's cross-contract call, timelock boundary correctness, and voting-power snapshotting.

The scope note is prepared for when an external audit is commissioned, but no audit has been scheduled as part of this epic's completion. This is acknowledged as a future step before any production deployment, not part of the epic E09 closure.

---

## Governance Invariants (Issue 0385)

The following invariants govern the system and are verified by automated tests:

1. **Timelock Invariant:** A proposal cannot execute before its timelock elapses.
2. **Voting Power Invariant:** Voting power is fixed at proposal creation and cannot be manipulated after the fact.
3. **Enumeration Invariant:** Only the enumerated proposal types (issue 0363) can ever be created — no arbitrary-call escape hatch exists.
4. **Admin Migration Invariant:** Once the registry's admin role is transferred to the governance contract, only governance itself can modify registry admin-gated parameters.
5. **CEI Invariant:** A proposal cannot be executed twice; execution state is finalized before any cross-contract calls.

---

## Summary

Epic E09 successfully decentralized control of the registry's protocol parameters by introducing a governance token ($KPRS) and a complete proposal-and-voting system. The admin migration, the most consequential change, has been performed on testnet and is confirmed to be irreversible without governance action.

All original design questions were answered and implemented as specified. The plutocracy risk inherent to token-weighted governance is documented and accepted. The security review covered all critical concerns. The testnet dry-run provided strong evidence of readiness.

Two questions remain deferred: proposal cancellation (accepted as out-of-scope for the initial release due to its own attack surface) and the external audit (scoped but not yet commissioned, reserved for a future step before production deployment).

The governance system is now the single source of truth for registry administration, moving the project from single-admin centralization to decentralized control.
