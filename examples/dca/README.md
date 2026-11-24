# Dollar-Cost Averaging (DCA) Keeper Task

This example demonstrates how an automated Dollar-Cost Averaging (DCA) investment strategy on Soroban can be executed on-chain via the **Soroban Keeper Network**.

---

## 1. Acceptance Criteria Verification

### Criterion 1: Each Period Swaps a Fixed Amount, Enforced On-Chain
The smart contract guarantees on-chain that every swap execution processes exactly `plan.fixed_swap_amount`, regardless of who invokes the transaction:
```rust
if plan.remaining_deposit < plan.fixed_swap_amount {
    return Err(DcaError::InsufficientRemainingDeposit);
}

let swap_amount = plan.fixed_swap_amount;
let actual_out = router_client.swap(&plan.token_in, &plan.token_out, &swap_amount, &min_amount_out, &plan.owner);
```
No keeper or frontrunner can alter the swap sizing or deplete more funds than configured in the plan.

### Criterion 2: Owner Can Stop the Schedule by Cancelling the Task
The owner maintains sovereign control of their capital and can terminate the schedule at any time:
```rust
pub fn cancel_dca_plan(env: Env, owner: Address, plan_id: u64) -> Result<i128, DcaError> {
    owner.require_auth();
    // Marks plan CANCELLED and transfers 100% of remaining unswapped token_in back to owner
}
```
Upon cancellation:
1. The remaining unswapped deposit is refunded back to the owner's wallet.
2. The plan status transitions to `Cancelled`.
3. The pending keeper task on the Keeper Registry is cancelled to prevent further keeper invocations.

---

## 2. Running the Tests

```bash
npm test
```

Sample output:
```text
✔ Criterion 1: Each period swaps a fixed amount, strictly enforced on-chain
✔ Criterion 2: The owner can stop the schedule by cancelling the pending task
```
