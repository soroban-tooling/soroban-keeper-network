# skn

`skn` is the command-line tool for the Soroban Keeper Network: deploying the
keeper contracts, registering and inspecting tasks, and running keeper
operations. Its scope, command tree, key handling and exit codes are fixed in
[`docs/CLI_DESIGN.md`](../../docs/CLI_DESIGN.md).

This package is built on [`@soroban-keeper-network/sdk`](../sdk-ts).

## Status

- `skn --help` lists every command group.
- `skn --version` prints the CLI version and the contract VERSIONs it supports.
- `skn config init` writes a config file with testnet, futurenet and mainnet
  profiles. `skn config show` prints the effective settings.
- `skn inspect version` prints the deployed contract's VERSION and whether
  this CLI supports it.
- `skn task show <id>` prints one task. `--json` returns its raw fields.
- `skn task list` filters tasks by status, owner or keeper, one page at a time.
- `skn task register` simulates a task, shows the fee, and submits after you
  confirm, or with `--yes`.

`task claim`, `task execute`, and the other command groups appear in help and
exit with code `2` until their issues land.

## Configuration

The config file is read from `SKN_CONFIG` if set, otherwise from
`~/.config/skn/skn.config.json`. Settings resolve in this order: flag, then the
selected profile, then the default (testnet).

```bash
skn config init                       # write the default config (refuses to overwrite; --force)
skn config show --profile futurenet   # print the effective settings
```

`config show` prints the signing key's source and origin, never the key.

## Signing keys

The key is read from the first source that is set, in this order:

1. `--key-file <path>`. On POSIX systems the file must not be readable by other
   users.
2. `--identity <name>`, from the Stellar CLI's identity store.
3. The `SKN_SECRET_KEY` environment variable.

No command prints a key. Errors name the source but never its contents.

## Tasks

```bash
skn task show 7 [--json]
skn task list --status pending --limit 20 [--cursor <id>] [--owner G...] [--keeper G...] [--indexer-url <url>]
skn task register --target C... --function liquidate --args '["G...", 5]' \
  --reward 5000000 --deadline +2h [--verifier C...] [--task-type custom] [--yes]
# or read the same fields from a file: skn task register --from task.json
```

The call is stored as UTF-8 JSON, `{"contract", "function", "args"}`, which
keepers must decode. The design doc (Task commands) covers the format, the
indexer's limits, and the fee estimate.

## Usage

```bash
skn inspect version --contract-id <C...> [--network testnet] [--rpc-url <url>] [--json]
```

`--network` selects a preset from the SDK (`testnet`, `futurenet` or
`mainnet`). `--rpc-url` overrides the preset's RPC URL.

Every command accepts `--json`. The output is one JSON document on stdout.
Integer fields that can exceed JavaScript's safe range, such as token amounts,
are decimal strings. A failing command with `--json` prints
`{ "error": { "code": ..., "message": ... } }` on stdout. Without `--json`, the
error goes to stderr. A contract error adds the error's name and a hint.

## Exit codes

| Code | Meaning |
|------|---------|
| `0` | Success. |
| `1` | Unexpected internal failure. |
| `2` | Usage error: bad flags, unknown command or profile, a missing or invalid key or config, or a command that is not implemented yet. |
| `3` | RPC or network error, including an unreachable indexer. |
| `4` | The contract rejected the call. The output names the error and says what to do. |
| `5` | Not found: no task has that ID. |

## Development

The CLI imports the SDK's built output, so build the SDK first:

```bash
cd packages/sdk-ts && npm ci && npm run build
cd ../cli && npm ci && npm run typecheck && npm run build && npm test
```

Or from the repository root, `make cli`.
