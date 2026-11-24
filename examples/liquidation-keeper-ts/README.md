# TypeScript Lending Liquidation Keeper

An automated lending liquidation keeper bot in TypeScript built on `@soroban-keeper-network/sdk`.

## Overview

This example demonstrates how an off-chain keeper bot monitors borrower health factors in a lending protocol, detects under-collateralized borrow positions, and automatically triggers on-chain liquidation tasks through the Soroban Keeper Network.

It serves as the TypeScript counterpart to the native Rust liquidation keeper example located at [`rust-sdk/examples/liquidation-keeper/`](../../rust-sdk/examples/liquidation-keeper/).

## Shared Mock Lending Contract

Both this TypeScript example and the Rust example share the same mock lending contract architecture:
- Contract source: [`contracts/mock-lending/`](contracts/mock-lending/)
- Implements position opening, collateral price oracle updates, health checks, and liquidation execution.

## Keeper Bot Lifecycle

1. **Monitor Health Factors**: Inspects positions where `collateral_amount * price < debt_amount * min_ratio`.
2. **Task Claiming**: Invokes `claim_task` on the Keeper Registry to acquire an exclusive lock window.
3. **Liquidation Execution**: Calls the lending contract's `liquidate` function to seize collateral.
4. **Proof Submission**: Submits the liquidation transaction hash and seized collateral receipt to `execute_task`.
5. **Reward Accrual**: Collects task bounty rewards via `withdraw_rewards`.

## Running Tests

### TypeScript
```bash
npm test --prefix examples/liquidation-keeper-ts
```

### Mock Lending Contract (Rust)
```bash
cargo test --manifest-path examples/liquidation-keeper-ts/contracts/mock-lending/Cargo.toml
```
