# Governance Design & Architecture

## Overview
The Soroban Keeper Network governance framework (`keeper-governance`) provides decentralized parameter adjustment, treasury administration, and contract upgrade capability using KPRS voting power.

## Proposal Lifecycle

```
[ Active (Voting Period) ] ──> [ Passed ] ──> [ Queued (Timelock Delay) ] ──> [ Executed ]
          │                          │                      │
          │                          └─── Defeated          │
          │                                                 │
          └──────────────── Cancelled <─────────────────────┘
```

1. **Active**: A token holder meeting the minimum proposal threshold (`100,000 KPRS`) submits a proposal for an enumerated governable action. Voting power is snapshotted at creation.
2. **Passed**: The proposal reaches the 4% quorum requirement and receives more `For` votes than `Against` votes by the end of the voting period.
3. **Queued**: The proposal enters a mandatory 48-hour timelock delay (`28,800 ledgers`) where network participants and keepers can review the impending parameter change.
4. **Executed**: After the timelock elapses, anyone may call `execute_proposal` to apply the parameter change.

---

## Proposal Cancellation Policy & Safeguards (Issue #500 Decision)

### Problem Statement
A proposal that has passed and is sitting in the timelock queue may later be recognized as harmful (e.g. an unforeseen economic exploit from an amended parameter, or sudden security issue). If queued changes were strictly irreversible and unstoppable, the timelock would merely act as an observational countdown without an actionable circuit-breaker.

### Cancellation Paths
`keeper-governance` defines two explicit, bounded cancellation routes via `cancel_proposal(caller, proposal_id)`:

1. **Proposer Cancellation**:
   - The original author/proposer can voluntarily cancel their proposal at any point before execution (during active voting or while queued in timelock).
   - Allows the author to retract a proposal upon discovering a typo, erroneous parameter, or community consensus against proceeding.

2. **Emergency Admin Veto**:
   - The contract `admin` holds an emergency veto power prior to execution.
   - Designed as a safeguard against malicious proposals, governance extraction attacks, or flash-loan-assisted vote swings during the network transition phase.

3. **Invariants**:
   - **No Cancellation After Execution**: An executed proposal cannot be cancelled (`CannotCancelExecuted`). State changes must occur via counter-proposals.
   - **No Double Cancellation**: Already cancelled proposals reject subsequent cancellations (`ProposalAlreadyCancelled`).
   - **Unauthorized Rejection**: Third parties who are neither the author nor admin cannot cancel proposals (`Unauthorized`).

### Risk Analysis & Safeguard Weighing
- **Admin Abuse Potential**: A compromised or malicious admin could theoretically veto legitimate community votes.
- **Mitigation & Future Path**: The emergency admin veto is scoped strictly to preventing execution (cannot force parameter mutations without full community voting). In phase 2, the admin role can be transferred to a security council multisig or a high-threshold emergency counter-vote DAO mechanism.
