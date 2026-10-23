# `skn` CLI design (E16)

> **Status:** accepted as the scope for epic E16. Later E16 issues implement
> against this document. Changing a decision here means updating this file
> first.

`skn` is a command-line tool for deploying the keeper registry and treasury,
registering and inspecting tasks, running keeper operations, and watching
events. This document fixes the language and package, the command tree, how
configuration and keys work, and the output and exit-code conventions.

## 1. Language and package

**Decision: TypeScript, in a new `packages/cli` package, built on
`@soroban-keeper-network/sdk` (`packages/sdk-ts`). The binary is `skn`.**

The reason is coverage of the contract's entry points today:

| Area | `packages/sdk-ts` | `rust-sdk` `KeeperRegistryClient` |
|------|-------------------|-----------------------------------|
| Register tasks | `registerTask`, `batchRegisterTasks` | `batch_register_tasks` only |
| Claim, execute, cancel | `claimTask`, `executeTask`, `cancelTask` | none |
| Expire, extend, increase reward | `expireTask`, `extendDeadline`, `increaseReward` | none |
| Keeper withdraw | `withdrawRewards` | none (`pending_reward` view only) |
| Admin | `admin.ts`, `adminDualAuth.ts` | `pause`, `unpause`, `set_fee_bps`, `set_min_reward`, `sweep_fees`, `initialize` |
| Staking | `staking.ts` | `stake_deposit`, `initiate_unbond`, `withdraw_stake`, `slash` |
| Views | `views.ts` | a subset (`get_tasks`, `keeper_stake`, `min_stake`) |

Every command in the tree below needs an entry point the TypeScript SDK
already has. The Rust client is missing the keeper lifecycle calls, so a Rust
CLI would first need an SDK expansion. Two more reasons favour TypeScript:

- `examples/batch-register` is already a Node script. Porting it into
  `skn batch register` keeps its logic and tests.
- `npx skn` distribution (issue 0470) follows the existing npm publish
  workflow for the SDK. A Rust binary would need a separate release channel.

A Rust CLI would give one static binary. We are not choosing it now, and it
should be revisited once `rust-sdk` covers the lifecycle calls.

The SDK's `src/testing/fakeRpc.ts` is the test double for command-level tests.

## 2. Command tree

Global flags apply to every command:

| Flag | Meaning |
|------|---------|
| `--profile <name>` | Named profile from the config file (default: `testnet`) |
| `--network <testnet\|futurenet\|mainnet>` | Overrides the profile's network |
| `--registry <C...>` | Registry contract id; overrides the profile |
| `--json` | Machine-readable output (section 5) |
| `--dry-run` | Build and simulate a state-changing command, never sign or submit |
| `--yes` | Skip the confirmation prompt for mainnet admin commands |

```
skn --version
skn --help
skn config init                      write a config with testnet, futurenet and mainnet profiles
skn config show                      print the effective values and where each came from

skn task register <file>             register one task from flags or a file
skn task show <id>
skn task list [--status ...] [--owner ...] [--limit N]
skn task claim <id>
skn task execute <id> [--proof <hex>]
skn task cancel <id>
skn task expire <id>
skn task extend-deadline <id> --ledgers N
skn task increase-reward <id> --amount N

skn keeper balance [<address>]
skn keeper withdraw
skn keeper stake <amount>
skn keeper unbond <amount>
skn keeper withdraw-stake

skn admin pause | unpause
skn admin set-fee <bps>
skn admin set-min-reward <amount>
skn admin transfer-admin <address>
skn admin sweep-fees <recipient> <amount>
skn admin upgrade <wasm-hash>

skn batch register <file.json|file.csv>

skn deploy registry <wasm>           deploy and initialize the registry
skn deploy treasury <wasm>           deploy and initialize the treasury

skn events watch [--type ...] [--from-ledger N]

skn inspect protocol                 summary: task counts, fee, pause state, admin
```

The exact flags for each command are fixed by the command's own issue. The
groups, names and nesting above are fixed here. Adding a group needs a
change to this section.

## 3. Configuration

Config lives in the platform config directory (`$XDG_CONFIG_HOME/skn/config.json`
on Linux and macOS, `%APPDATA%\skn\config.json` on Windows). `SKN_CONFIG`
overrides the path.

Each profile holds `rpcUrl`, `networkPassphrase`, `registryContractId` and,
optionally, `treasuryContractId`. The three built-in profiles take their RPC
URL and passphrase from the SDK's network presets (`packages/sdk-ts/src/network.ts`),
so `skn` and the SDK agree on each network.

**A config file never holds a key.** It is safe to commit or share.

Precedence, highest first:

1. Command-line flags
2. `SKN_*` environment variables (`SKN_NETWORK`, `SKN_REGISTRY`, `SKN_RPC_URL`, ...)
3. The selected profile
4. Built-in defaults

`skn config show` prints each value with its source, so a surprising value can
be traced.

## 4. Keys

A signing key is needed only by commands that submit a transaction. Read-only
commands and `--dry-run` never need one.

**Supported sources, in this order:**

1. `SKN_SECRET_KEY`, an environment variable holding an `S...` seed.
2. `--key-file <path>`, a file whose contents are the seed. On POSIX the
   command refuses the file if its mode allows group or other access.

**Rules that every command must follow:**

- **No secret on the command line.** A secret passed as an argument ends up in
  shell history and in the process list. If an argument looks like a seed
  (`S` followed by 55 base32 characters), the command exits with a usage error
  (exit 2) and tells the user to use `SKN_SECRET_KEY` or `--key-file`.
- **Never printed.** Output, errors, `--json` documents and `--debug` traces
  show only the public key (`G...`). Every error message goes through a
  redactor that replaces the loaded secret and any `S...` string with
  `<redacted>` before printing.
- **Never passed to a child process on argv.** If `deploy` shells out to the
  Stellar CLI, the key reaches that process another way, not as an argument.
- **Held in memory only.** The key is read once, turned into a keypair, and
  not copied into logs, config or caches.
- **Dry runs** with no key use a throwaway keypair as the simulation source,
  as `examples/keeper-bot` does in dry-run mode.

The "never printed" rule is tested. Command tests run each command, including
its error paths, with a known fake seed and assert the seed appears nowhere in
stdout or stderr. The security review issue (in the CLI backlog) checks the
same property before release.

## 5. Output

Human output is the default. Results go to stdout. Progress and warnings go to
stderr, so `skn task list > out.txt` captures only the result.

`--json` writes exactly one JSON document to stdout per invocation and nothing
else, including in progress and error paths:

```json
{"ok": true, "command": "task show", "data": {"id": "42", "status": "Pending", "reward": "1000000"}}
```

```json
{"ok": false, "command": "task claim", "error": {"code": "CONTRACT_REJECTED", "contractError": "NotTaskClaimer", "message": "The contract rejected the claim: NotTaskClaimer", "exitCode": 6}}
```

Conventions:

- Integers that can exceed 2^53 (`i128` amounts, `u64` task ids) are JSON
  strings, so no consumer loses precision.
- Timestamps are ISO 8601 in UTC.
- `error.code` values are stable and part of the interface: `USAGE`,
  `CONFIG_MISSING`, `KEY_INVALID`, `KEY_FILE_INSECURE`, `RPC_UNAVAILABLE`,
  `SIMULATION_FAILED`, `CONTRACT_REJECTED`, `INTERNAL`. Adding a code is
  allowed. Renaming or removing one is a breaking change.
- `CONTRACT_REJECTED` includes the `KeeperErrorCode` name from the SDK's
  `decodeKeeperError`, so scripts can branch on the contract error without
  parsing the message.

Human messages for every `KeeperErrorCode` come from the same table, so the
two outputs never disagree.

## 6. Exit codes

| Code | Meaning |
|------|---------|
| 0 | Success, including a successful `--dry-run` |
| 1 | Internal error (a bug in `skn`) |
| 2 | Usage error: bad flags or arguments, a secret passed on the command line, or a mainnet admin command without `--yes` when there is no TTY |
| 3 | Configuration error: missing profile or registry, malformed config |
| 4 | Key error: no key where one is needed, invalid seed, insecure key file |
| 5 | Network error: RPC unreachable after the SDK's retry policy |
| 6 | Rejected: simulation failed or the contract or network rejected the transaction |
| 130 | Interrupted (SIGINT), for example `events watch` |

Scripts should branch on the exit code and read `error.code` only for detail.

## 7. Safety for state-changing commands

- `--dry-run` builds and simulates the transaction, prints the simulation
  result and resource cost, and exits 0 without signing.
- Mainnet admin commands (`admin ...`, `deploy ...`) ask for confirmation on a
  TTY. Without a TTY they require `--yes`, or they exit 2. A non-interactive
  pipeline cannot approve a mainnet change by accident.
- Testnet and futurenet skip the prompt.

## 8. Testing

- Command-level tests run each command against `fakeRpc` from `packages/sdk-ts`.
- Every command has a `--json` test and a human-output test.
- The secret-leak test in section 4 covers every command.
- The CLI runs in CI as a job once the scaffold lands (backlog issue 0469).

## 9. Packaging

- Package name `@soroban-keeper-network/cli`, binary `skn`, depending on the
  SDK by workspace version.
- Published the same way as the SDK (`.github/workflows/sdk-ts-publish.yml`).
- `skn --version` prints the CLI version and the contract versions it supports
  (`SUPPORTED_CONTRACT_VERSIONS` from the SDK).

## 10. Open questions for later issues

- **How `deploy` installs WASM.** Either the SDK uploads the WASM through RPC,
  or `deploy` shells out to the Stellar CLI. The Stellar CLI is already a
  prerequisite (see `docs/DEPLOYING.md`). Whichever path is chosen, section 4's
  rule holds: the key never goes on argv. This is decided in the deploy issue.
- **Keystore aliases.** Reading keys from the Stellar CLI's keystore (`stellar
  keys`) would avoid storing seeds in env vars. It is deferred past the first
  release.
- **Amount formatting.** Amounts are raw base units in v1. Decimal formatting
  would need the reward token's decimals, which the CLI does not read yet.
