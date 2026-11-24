# Auction Settlement Keeper Task

This example demonstrates how an English auction contract on Soroban can be settled autonomously by the **Soroban Keeper Network** immediately after the auction end time.

---

## 1. Acceptance Criteria Verification

### Criterion 1: Settlement Before End Time Fails
The smart contract guarantees on-chain that calling `settle_auction()` before the auction end time reverts:
```rust
let current_time = env.ledger().timestamp();
if current_time < auction.end_time {
    return Err(AuctionError::AuctionNotEnded);
}
```
No keeper or external caller can prematurely settle or terminate an ongoing bidding window.

### Criterion 2: Task Deadline is Set Relative to Auction End
When creating the keeper task, the execution deadline is computed relative to the auction end timestamp:
$$\text{Trigger Timestamp} = \text{Auction End Time}$$
$$\text{Task Deadline} = \text{Auction End Time} + \text{Settlement Window Seconds}$$

For example, for an auction ending at timestamp `1,003,600` with a 1-hour settlement window (`3,600s`), the task deadline is strictly set to `1,007,200`.

---

## 2. Running the Tests

```bash
npm test
```

Sample output:
```text
✔ Criterion 1: Settlement before the end time strictly fails
✔ Criterion 2: The task deadline is set relative to the auction end
```
