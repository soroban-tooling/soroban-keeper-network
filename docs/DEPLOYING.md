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

The bot can be run as a long-running daemon or as a one-shot process via cron.

### Daemon mode

This is the default. The bot will poll for tasks every `POLL_INTERVAL_MS`.

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

### Cron mode

For serverless or cron-based deployments, use the `--once` flag or the
`RUN_ONCE=true` environment variable. The bot will run one round and exit with a
status code indicating success (0) or failure (non-zero).

**Example crontab (runs every minute):**

```crontab
# /etc/cron.d/keeper-bot
* * * * * your-user /path/to/soroban-keeper-network/examples/keeper-bot/run.sh >> /var/log/keeper-bot.log 2>&1
```

You'll need a wrapper script like `run.sh` to `cd` into the right directory
and invoke `node`.

**`run.sh`**
```bash
#!/bin/sh
cd /path/to/soroban-keeper-network/examples/keeper-bot
/usr/bin/node index.js --once
```

This setup ensures that even if one run fails, the next minute's run will try
again, providing resilience without requiring a long-lived process.

## Verifying a deployment

Add the contract to a block explorer link for your application:

```
https://stellar.expert/explorer/testnet/contract/<CONTRACT_ID>
```

## Publishing the TypeScript SDK

`packages/sdk-ts` (`@soroban-keeper-network/sdk`) publishes to npm
independently of the contract's own `vX.Y.Z` releases above — it has its
own tag namespace and its own workflow
(`.github/workflows/sdk-ts-publish.yml`), so a contract release never
triggers an npm publish and an SDK publish never tags a contract release.

1. **Bump the version** in `packages/sdk-ts/package.json`.
2. **Commit and tag it** as `sdk-ts-v<version>`, matching the bumped
   version exactly — the workflow verifies this and fails the publish
   otherwise:
   ```sh
   git commit -am "chore(sdk-ts): bump to 0.2.0"
   git tag -a sdk-ts-v0.2.0 -m "sdk-ts v0.2.0"
   git push origin main sdk-ts-v0.2.0
   ```
3. The workflow runs on that tag push: installs, runs the full unit test
   suite and lint as a hard gate, builds, smoke-tests the built package
   by type-checking `examples/node-signing` against `dist/` (not
   source — this is what actually proves the published API works for a
   real consumer), then publishes with npm's
   [provenance](https://docs.npmjs.com/generating-provenance-statements)
   attached.
4. It never runs on an ordinary merge to `main` — only on a
   `sdk-ts-v*.*.*` tag push, or manually via `workflow_dispatch` for an
   existing tag.

**One-time setup for whoever configures repository secrets:** create an
npm [granular access
token](https://docs.npmjs.com/creating-and-viewing-access-tokens#creating-granular-access-tokens)
scoped to **only** the `@soroban-keeper-network/sdk` package with
publish permission (not a personal account token, and not one scoped to
the whole npm account/org) — automation tokens can also be restricted to
never expire without triggering npm's normal login re-auth prompts, but
prefer a token with an expiry you rotate over one that doesn't, and
revoke it immediately if this workflow or its secret is ever suspected
compromised. Add it as the `SDK_TS_NPM_TOKEN` secret on the repository's
`npm-publish` GitHub Environment (not a plain repository secret) so it's
protected by that environment's own review/approval rules.
