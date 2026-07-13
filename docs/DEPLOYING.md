# Deploying & Running

A step-by-step guide to deploy the `KeeperRegistry` to Stellar testnet and run a
keeper bot against it.

## Prerequisites

- Rust with the `wasm32-unknown-unknown` target:
  ```bash
  rustup target add wasm32-unknown-unknown
  ```
- The [Stellar CLI](https://developers.stellar.org/docs/tools/developer-tools/cli/stellar-cli)
  (`stellar`), formerly `soroban`.
- Node.js ≥ 18 (for the keeper bot).

## 1. Build the contract

```bash
make wasm        # or: ./scripts/optimize.sh
```

This produces `target/wasm32-unknown-unknown/release/keeper_registry.wasm`.

## 2. Create and fund a testnet identity

```bash
stellar keys generate deployer --network testnet
stellar keys fund deployer --network testnet
```

## 3. Deploy

```bash
stellar contract deploy \
  --wasm target/wasm32-unknown-unknown/release/keeper_registry.wasm \
  --source deployer \
  --network testnet
# → prints the deployed CONTRACT_ID (C...)
```

> The repo also ships `scripts/deploy.sh` which wraps these steps.

## 4. Initialize

Pick a reward token — on testnet you can use the native XLM SAC address from
`stellar contract id asset --asset native --network testnet`.

```bash
stellar contract invoke --id <CONTRACT_ID> --source deployer --network testnet -- \
  initialize \
  --admin <DEPLOYER_ADDRESS> \
  --reward_token <TOKEN_SAC_ADDRESS> \
  --fee_bps 300
```

## 5. Register a task (as a dApp)

```bash
stellar contract invoke --id <CONTRACT_ID> --source deployer --network testnet -- \
  register_task \
  --owner <OWNER_ADDRESS> \
  --task_type Liquidation \
  --calldata <HEX_BYTES> \
  --reward 1000000 \
  --deadline <UNIX_TS> \
  --ttl_ledgers 17280 \
  --lock_ledgers 120
```

## 6. Run the keeper bot

```bash
cd examples/keeper-bot
cp .env.example .env
# edit .env: KEEPER_SECRET_KEY, REGISTRY_CONTRACT_ID, NETWORK=testnet
npm install
npm start
```

The bot polls for `TaskRegistered` events, claims claimable tasks, executes them
off-chain, submits proof via `execute_task`, and periodically withdraws accrued
rewards. It also expires past-deadline tasks (`EXPIRE_STALE_TASKS=true`) to
refund owners. See the header of `examples/keeper-bot/index.js` for tuning knobs
(`POLL_INTERVAL_MS`, `MAX_RETRIES`, `WITHDRAW_THRESHOLD`, …).

## Verifying a deployment

Add the contract to a block explorer link for your application:

```
https://stellar.expert/explorer/testnet/contract/<CONTRACT_ID>
```
