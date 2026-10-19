# `skn` command-line tool: scope and architecture

`skn` is the command-line tool for deploying the keeper contracts, registering
and inspecting tasks, and running keeper operations (epic E16). This document
fixes the decisions that the `skn` implementation issues build against:
language and package location, the command tree, configuration, key handling,
output formats, and exit codes. Changing any of these is a design change and
should go through a GitHub Discussion first, as [CONTRIBUTING.md](../CONTRIBUTING.md)
requires for major design changes.

## Language and package location

`skn` is written in TypeScript and lives in `packages/cli`, built on
`@soroban-keeper-network/sdk` (`packages/sdk-ts`).

Reason: the TypeScript SDK already covers every entry point the CLI needs
(registration, views, claim and execute, admin and dual-auth calls, treasury,
events). The Rust SDK (`rust-sdk/`) does not yet cover them. Building on the
TypeScript SDK means the CLI adds no new contract-encoding code, and its
command tests can reuse the SDK's test RPC (`FakeRpc` in
`packages/sdk-ts/test/support/fakeRpc.ts`), which round-trips arguments and
results through the real `@stellar/stellar-sdk` encoders.

The package is published as an executable `skn` bin. Publishing is out of
scope for this design.

## Command tree

```
skn --help
skn --version

skn config init | show                  # config file and profiles
skn task register | show | list | claim | execute
skn keeper balance | withdraw
skn admin <subcommand>                  # one subcommand per admin entry point
skn batch register                      # port of examples/batch-register
skn deploy registry | treasury
skn events watch
skn inspect version | summary
```

Each group appears in `skn --help`, including groups whose subcommands are
not implemented yet. Running an unimplemented subcommand exits with the usage
code (`2`) and says that it is not implemented yet.

Global flags, accepted by every command:

| Flag | Meaning |
|------|---------|
| `--network <testnet\|futurenet\|mainnet>` | Selects a preset from the SDK's `NETWORK_PRESETS`. |
| `--rpc-url <url>` | Overrides the preset's RPC URL. |
| `--contract-id <id>` | The keeper-registry contract to talk to. |
| `--json` | Machine-readable output (see below). |
| `--profile <name>` | Named profile from the config file (see below). |

Flags override the profile, which overrides defaults. `skn config show`
prints the effective values.

## Configuration

Config is a single file. It is read from `SKN_CONFIG` if that is set, otherwise
from `~/.config/skn/skn.config.json`. A missing file is fine: commands fall back
to flags and defaults. A file that exists but is malformed is an error. It holds
named profiles:

```json
{
  "defaultProfile": "testnet",
  "profiles": {
    "testnet":   { "network": "testnet",   "contractId": "C..." },
    "futurenet": { "network": "futurenet", "contractId": "C..." },
    "mainnet":   { "network": "mainnet",   "contractId": "C..." }
  }
}
```

Profiles never store secrets. Key material comes only from the key sources
below.

Mainnet commands that send transactions require an explicit confirmation flag,
`--confirm-mainnet`. `config show` reports the flag's value so a script can check it.

## Keys

Keys are supplied by one of three sources, never as a bare command-line
argument, because argv is visible to other processes:

1. An environment variable, `SKN_SECRET_KEY`.
2. A key file, `--key-file <path>`. On POSIX systems the file must not be readable
   by other users, and a file with broader permissions is refused. Windows has no
   POSIX permission bits, so the check does not apply there; keep the file in a
   directory only your account can read.
3. The Stellar CLI's identity store, `--identity <name>`, read from
   `~/.config/stellar/identity/<name>.toml`. Seed-phrase identities are not
   supported yet.

When more than one source is set, the precedence is `--key-file`, then
`--identity`, then `SKN_SECRET_KEY`. The precedence is documented in the
command help as well as in the README.

**No command prints a secret.** This includes normal output, `--json` output,
logs, and error messages. A key never appears in any output, and tests assert
it, including for failing commands.

## Output

Default output is human-readable text on stdout. Errors go to stderr.

`--json` switches every command to JSON on stdout:

- The output is valid JSON for every command, including failures. With
  `--json`, an error is `{ "error": { "code": ..., "message": ... } }`.
- Integer fields that can exceed JavaScript's safe range (token amounts,
  stroops, ledger-scale values) are serialized as decimal strings, never as
  JSON numbers.
- Field names are the raw fields as the SDK returns them (camelCase).

Human formatting may differ between commands, but `--json` output is a stable
interface for scripts.

## Exit codes

| Code | Meaning |
|------|---------|
| `0` | Success. |
| `1` | Unexpected internal failure. |
| `2` | Usage error: bad flags, unknown command, unimplemented subcommand. |
| `3` | RPC or network error. The node could not be reached or returned an error. |
| `4` | The contract rejected the call. The error code is in the output. |
| `5` | Not found: the requested ID (for example a task) does not exist. |

Usage errors are never reported as contract errors, and RPC errors are never
reported as usage errors.

## Confirmation before transactions

Commands that submit a transaction simulate it first and show the fee before
submitting. `--yes` skips the confirmation prompt. Simulation-only commands
never prompt.

## Testing

Each command has a test that runs it end to end against the SDK's fake RPC,
covering success, a contract error, and `--json` output. The shared harness
is `packages/cli/test/support/`.

## Scope of this document

This document covers the design decisions. The implementation status of each
command is tracked by its own issue.
