# Keeper-Executed Governance Proposal Task

This example demonstrates how passed DAO governance proposals on Soroban can be queued with an on-chain timelock and executed permissionlessly by the **Soroban Keeper Network** immediately after the timelock expires.

---

## 1. Acceptance Criteria Verification

### Criterion 1: Task Registered When Proposal Passes, Executes After Timelock
When a proposal achieves quorum and voting passes, the event listener registers a keeper task targeting the proposal's execution ETA:
$$\text{Timelock ETA} = \text{Passed Timestamp} + \text{Timelock Duration}$$
The task attaches a time-window condition gating keeper claims until `current_timestamp >= timelock_eta`.

### Criterion 2: Execution Before Timelock Fails On-Chain
The smart contract guarantees on-chain that calling `execute_proposal` before the timelock ETA reverts:
```rust
let current_time = env.ledger().timestamp();
if current_time < proposal.eta {
    return Err(GovernanceError::TimelockNotElapsed);
}
```
No keeper, admin, or unauthorized party can execute a queued proposal prematurely.

---

## 2. Running the Tests

```bash
npm test
```

Sample output:
```text
✔ Criterion 1: Task is registered when a proposal passes and executes after the timelock
✔ Criterion 2: Execution before the timelock fails on-chain
```
