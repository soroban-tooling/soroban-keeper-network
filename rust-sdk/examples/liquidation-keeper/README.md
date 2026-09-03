# Minimal Rust Liquidation Keeper

This example demonstrates how to build a native Rust keeper bot using `soroban-keeper-sdk` to monitor, claim, execute, and withdraw liquidation tasks on the Soroban Keeper Network.

## Architecture

1. **Task Polling & Inspection**: Uses `KeeperClient::get_tasks_range` to query active tasks directly from the on-chain registry.
2. **First-Come First-Served Claiming**: Invokes `claim_task` with exclusive lock window protection.
3. **Off-Chain Execution & Proof Submission**: Calculates liquidations off-chain and submits completion proofs via `execute_task`.
4. **Reward Withdrawal**: Periodically checks `keeper_balance` and pulls earnings using `withdraw_rewards`.

## Differences from JavaScript `keeper-bot`

- **Stateless**: Focuses on in-memory polling and execution without requiring external database state.
- **Embedded RPC/Contract Primitives**: Uses native type definitions and `TransactionSigner` abstraction from `soroban-keeper-sdk`.
