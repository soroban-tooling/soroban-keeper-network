# Minimal Rust Liquidation Keeper

This example demonstrates how to build a native Rust keeper bot using `soroban-keeper-sdk` to monitor, claim, execute, and withdraw liquidation tasks on the Soroban Keeper Network against the shared mock lending contract (`examples/liquidation-keeper-ts/contracts/mock-lending`).

## Architecture

1. **Task Polling & Inspection**: Uses `KeeperClient::get_tasks_range` to query active tasks directly from the on-chain registry.
2. **First-Come First-Served Claiming**: Invokes `claim_task` with exclusive lock window protection.
3. **Off-Chain Execution & Proof Submission**: Inspects health factor on the shared mock lending contract, executes liquidations, and submits completion proofs via `execute_task`.
4. **Reward Withdrawal**: Periodically checks `keeper_balance` and pulls earnings using `withdraw_rewards`.

## Shared Mock Lending Contract

This Rust keeper shares its mock lending protocol implementation with the TypeScript liquidation keeper example located at [`examples/liquidation-keeper-ts/`](../../../examples/liquidation-keeper-ts/).
