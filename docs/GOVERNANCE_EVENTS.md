# Governance Events

Events are the governance contract's audit trail and the primary query interface for off-chain indexers, analytics dashboards, and keeper bots. The table below is transcribed from the `emit_*` functions in `contracts/governance/src/events.rs` and lists every event the contract emits, and nothing it does not. It follows the project-wide two-topic conventions described in [README.md's Events section](../README.md#events) and [docs/TREASURY_EVENTS.md](TREASURY_EVENTS.md).

Build event filters from the **Topics** column only. The `Event` names are documentation labels, not on-chain values.

Every event publishes topic symbols conforming to Soroban's `symbol_short!` literal constraints (at most 9 characters), standardizing on the `(verb, "gov")` topic pair across the full proposal life cycle.

| Event | Emitted by | Topics | Data (in order, with type) |
|---|---|---|---|
| `ProposalCreated` | `propose` | `("proposed", "gov")` | `(proposal_id: u64, proposer: Address, eta: u64)` |
| `VoteCast` | `cast_vote` | `("vcast", "gov")` | `(proposal_id: u64, voter: Address, support: u32, voting_power: i128)` |
| `ProposalPassed` | `record_outcome` | `("passed", "gov")` | `(proposal_id: u64, votes_for: i128, votes_against: i128, votes_abstain: i128)` |
| `ProposalDefeated` | `record_outcome` | `("defeat", "gov")` | `(proposal_id: u64, votes_for: i128, votes_against: i128, votes_abstain: i128)` |
| `ProposalQueued` | `queue_proposal` | `("queued", "gov")` | `(proposal_id: u64, eta: u64)` |
| `ProposalExecuted` | `execute_proposal` | `("executed", "gov")` | `(proposal_id: u64,)` |
| `ProposalExecutionFailed` | `execute_proposal` | `("exfail", "gov")` | `(proposal_id: u64, error_code: u32)` |
| `ProposalCancelled` | `cancel_proposal` | `("cancel", "gov")` | `(proposal_id: u64,)` |
| `AdminMigrated` | `accept_admin` | `("admin_migrated", current_admin, governance_addr)` | `(registry: Address,)` |

---

## Design Decisions: Voter Transparency vs. Privacy

A foundational question in governance protocol design is whether individual ballots should be emitted publicly or restricted to aggregate tallies.

### Decision: Full Public Transparency for Ballots

In `VoteCast`, the governance contract emits:
```rust
(proposal_id: u64, voter: Address, support: u32, voting_power: i128)
```

**Rationale:**
1. **Public Verifiability & Auditability**:
   In decentralized autonomous organizations, protocol decisions govern shared financial infrastructure (fee levels, pause state, contract upgrades). Token holders and keepers must be able to verify that the final tally matches the sum of eligible, snapshot-weighted votes cast during the voting window.
2. **Keeper & Stakeholder Accountability**:
   Prominent protocol delegates, foundation participants, and large keepers are expected to vote in alignment with protocol health and community commitments. Public ballots allow the community to audit delegate voting history.
3. **Sybil & Flash-Loan Attack Analysis**:
   Emitting the voter address and snapshot voting power enables off-chain telemetry and security monitors to detect anomalous voting concentrations or hostile governance takeovers before execution timelocks expire.
4. **No Uncommitted Information Leakage**:
   The vote is cast on-chain after the snapshot ledger has already closed. Emitting `(voter, support, voting_power)` does not leak private cryptographic keys or uncommitted intentions; it merely mirrors the public ledger state that the transaction itself produced.

---

## Reconstructing Full Proposal History From Events Alone

The complete lifecycle and state of any proposal can be deterministically reconstructed from the event log alone without querying contract storage:

1. **`ProposalCreated` (`("proposed", "gov")`)**:
   - Initializes a new proposal entry with `id = proposal_id`, `proposer = proposer`, and status `Active`.
   - Records the snapshot ledger sequence and initial vote tallies (`for = 0`, `against = 0`, `abstain = 0`).

2. **`VoteCast` (`("vcast", "gov")`)**:
   - Records an individual vote by `voter` with `support` (`0 = Against`, `1 = For`, `2 = Abstain`) and weight `voting_power`.
   - Increments the corresponding tally counter.

3. **`ProposalPassed` / `ProposalDefeated` (`("passed", "gov")` / `("defeat", "gov")`)**:
   - Reconciles the final tally against quorum and passing thresholds.
   - Updates status to `Passed` or `Defeated`.

4. **`ProposalQueued` (`("queued", "gov")`)**:
   - Updates status to `Queued` with execution unlock time `eta`.
   - Starts the mandatory timelock countdown.

5. **`ProposalExecuted` / `ProposalExecutionFailed` (`("executed", "gov")` / `("exfail", "gov")`)**:
   - Finalizes status to `Executed` or records downstream failure with `error_code`.

6. **`ProposalCancelled` (`("cancel", "gov")`)**:
   - Updates status to `Cancelled`.

This replay pattern is validated in `contracts/governance/src/test.rs` under `test_full_lifecycle_history_reconstruction_from_events`.
