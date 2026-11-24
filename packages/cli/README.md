# skn

`skn` is the command-line tool for the Soroban Keeper Network: deploying the
keeper registry and treasury contracts, registering tasks (single or batch),
inspecting protocol state, and running admin operations.

This package is built on [`@soroban-keeper-network/sdk`](../sdk-ts).

## Install

Node 18 or newer is required. The CLI is built from this checkout:

```sh
git clone https://github.com/soroban-tooling/soroban-keeper-network.git
cd soroban-keeper-network/packages/sdk-ts
npm ci && npm run build
cd ../cli
npm ci && npm run build
npm link
```

`npm link` puts `skn` on your PATH. Without it, run `node dist/index.js` from
`packages/cli` in place of `skn`. Check the install with `skn --help` and
`skn --version`.

## Quickstart

These steps use testnet only. They deploy a registry, register a task with the
CLI, then run the example keeper bot so you can watch the task being executed.

### 1. Create and fund an account

```sh
npm install --global @stellar/stellar-cli
stellar keys generate --global quickstart
stellar keys fund quickstart --network testnet
export SKN_SECRET_KEY=$(stellar keys show --secret quickstart)
```

The Stellar testnet friendbot funds the account. `SKN_SECRET_KEY` is the only
environment variable the CLI reads for a signing key. Treat it like a password:
do not paste it into a shell history you share or commit it.

### 2. Deploy a registry

From the repository root, with the Rust `wasm32-unknown-unknown` target and the
Stellar CLI installed:

```sh
export DEPLOYER_SECRET_KEY="$SKN_SECRET_KEY"
export ADMIN_ADDRESS=$(stellar keys address quickstart)
./scripts/deploy.sh testnet
```

Copy the `Contract ID: C...` line from the output:

```sh
export CONTRACT_ID=C...   # the ID printed by deploy.sh
```

### 3. Configure the CLI

```sh
skn config init
skn config show --network testnet --contract-id "$CONTRACT_ID"
```

`config init` writes profiles for testnet, futurenet and mainnet. It stores no
secrets. Settings come from flags or from the selected profile; the CLI has no
`SKN_NETWORK` or `SKN_CONTRACT_ID` variables, so pass `--contract-id` on each
command or add it to the `testnet` profile in the config file.

The `config show` output includes a `signing key:` line with the source
(`env SKN_SECRET_KEY`) and the key's public address. It never prints the secret.

### 4. Register a task

```sh
skn task register --network testnet --contract-id "$CONTRACT_ID" \
  --type ttl-extension --reward 5000000 \
  --deadline 2030-01-01T00:00:00Z \
  --ttl-ledgers 17280 --lock-ledgers 100
```

`ttl-extension` is the task type the example bot knows how to execute. The
reward is in stroops (10,000,000 stroops is 1 XLM). The command signs as the
task owner and prints the task's state as read back from the registry. Note the
task ID in that output.

### 5. Watch a keeper execute it

In a second terminal, still in the repository root:

```sh
cd packages/sdk-ts && npm ci && npm run build && cd ../..
cd examples/keeper-bot && npm ci
NETWORK=testnet \
REGISTRY_CONTRACT_ID="$CONTRACT_ID" \
KEEPER_SECRET_KEY="$SKN_SECRET_KEY" \
SIMULATE_EXECUTION=true \
POLL_INTERVAL_MS=2000 \
node index.js
```

`SIMULATE_EXECUTION=true` is for local testnet experiments only: it fabricates
a proof instead of performing real off-chain work. With it, the bot claims the
`ttl-extension` task and submits `execute_task`; its structured log shows the
claim, the execution and the resulting state. Stop it with Ctrl+C. Remove that
variable and register a real executor in `index.js` before using a keeper for
anything else. See the [bot README](../keeper-bot/README.md) for dry-run mode
and optional metrics.

Confirm the final state from the first terminal:

```sh
skn inspect --network testnet --contract-id "$CONTRACT_ID"
```

## Command reference

The [generated reference](../../docs/CLI.md) has one section per command, each
rendered from `skn <command> --help`. To regenerate it after changing help
text:

```sh
cd packages/cli && npm run docs:generate
```

## Commands

- `skn --help` lists command groups and global flags
- `skn --version` prints the CLI version and supported contract `VERSION` range
- `skn config init [--force]` writes a config with `testnet`, `futurenet`, and `mainnet` profiles
- `skn config show` prints effective configuration and signing-key source, never the secret
- `skn inspect [summary | version]` reads protocol state and SDK compatibility
- `skn admin <pause|unpause|set-fee-bps|set-min-reward|set-min-stake|set-dispute-window|sweep-fees>` runs admin operations with pre-flight admin verification, current and new value display, and confirmation
- `skn task <register|cancel|expire|increase-reward|extend-deadline>` manages a task as its owner (see [Task commands](#task-commands))
- `skn keeper <balance|withdraw|stake|unbond|withdraw-stake|unbonding>` reports a keeper's balance, stake and rewards (see [Keeper commands](#keeper-commands))
- `skn batch register <tasks.json|tasks.csv> [--dry-run]` validates and chunks a task list by `max_batch_size`
- `skn deploy [registry|treasury|all]` uploads WASM, deploys, initializes, and saves contract IDs to the selected profile

## Task commands

Amounts are in the reward token's smallest unit (stroops for XLM). Times are Unix seconds or ISO 8601 (`2030-01-01T00:00:00Z`). Every task command signs as the owner and ends by printing the task's state as read back from the registry.

```sh
skn task register --type liquidation --reward 5000000 --deadline 2030-01-01T00:00:00Z \
    --ttl-ledgers 17280 --lock-ledgers 100 [--calldata 0a1b] [--verifier C...]
skn task cancel <task-id>
skn task expire <task-id>
skn task increase-reward <task-id> --by <amount>
skn task extend-deadline <task-id> --to <time>
```

- `cancel` works on a pending task, or on a claimed task whose lock has lapsed. If the lock is still live it exits `4` and says who holds the task and when the lock lapses, with the ledger and a rough wait. A task that is already executed, cancelled or expired reports that it can never be cancelled.
- `expire` can be run by any account; the signing key only pays the fee.

## Keeper commands

```sh
skn keeper balance [--keeper G...]   # reward balance, bonded stake, unbonding, effective reputation
skn keeper withdraw                  # withdraw the signing keeper's reward balance
skn keeper stake <amount>            # deposit collateral
skn keeper unbond <amount>           # start the unbonding delay
skn keeper unbonding [--keeper G...] # the pending unbond request
skn keeper withdraw-stake            # release the unbonded stake
```

- `balance` defaults to the signing key's address when `--keeper` is not given, and then needs no signing key if `--keeper` is. Reputation is the contract's `effective_reputation`, decayed to the current ledger, shown as a percentage with executed and missed counts. If the registry has no such view, the rest still prints and a warning says so.
- `withdraw` checks the balance first. A zero balance prints "Nothing to withdraw" and sends no transaction.
- `unbond` prints the ledger at which the stake becomes withdrawable, with a rough wait and time. Only one unbond request can be pending at a time.
- `withdraw-stake` before the unlock ledger exits `4` with `UnbondNotReady`, the remaining wait, and the words "Nothing was sent". It also checks that there is a request to withdraw at all.

All of these refuse to send on mainnet without `--confirm-mainnet`, except where nothing would be sent.

## Signing keys

Keys are resolved in precedence order and are never echoed to stdout, stderr, or logs:

1. `--key-file <path>` (refused on POSIX if readable by group/others)
2. `--identity <name>` (from `~/.config/stellar/identity/<name>.toml`)
3. `SKN_SECRET_KEY` environment variable

Operator-facing text is redacted before it is printed: API keys embedded in an
RPC URL and any secret seed that appears in an error message are removed. See
[the CLI security review](../../docs/CLI_SECURITY_REVIEW.md).

## Exit codes

| Code | Meaning |
|------|---------|
| `0` | Success |
| `1` | Unexpected internal failure |
| `2` | Usage, configuration, settings, or key error |
| `3` | RPC or network error |
| `4` | Contract error |
| `5` | Not found |
