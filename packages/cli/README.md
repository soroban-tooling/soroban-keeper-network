# skn

`skn` is the command-line tool for the Soroban Keeper Network: deploying the
keeper contracts, registering and inspecting tasks, and running keeper
operations. Its scope, command tree, key handling and exit codes are fixed in
[`docs/CLI_DESIGN.md`](../../docs/CLI_DESIGN.md).

This package is built on [`@soroban-keeper-network/sdk`](../sdk-ts).

## Status

The scaffold is in place:

- `skn --help` lists every command group.
- `skn --version` prints the CLI version and the contract VERSIONs it supports.
- `skn inspect version` prints the deployed contract's VERSION and whether
  this CLI supports it.

The other command groups appear in help and exit with code `2` until their
issues land.

## Usage

```bash
skn inspect version --contract-id <C...> [--network testnet] [--rpc-url <url>] [--json]
```

`--network` selects a preset from the SDK (`testnet`, `futurenet` or
`mainnet`; default `testnet`). `--rpc-url` overrides the preset's RPC URL.

## Exit codes

| Code | Meaning |
|------|---------|
| `0` | Success. |
| `1` | Unexpected internal failure. |
| `2` | Usage error: bad flags, unknown command, or a command that is not implemented yet. |
| `3` | RPC or network error. |
| `4` | The contract rejected the call. |
| `5` | Not found. |

## Development

The CLI imports the SDK's built output, so build the SDK first:

```bash
cd packages/sdk-ts && npm ci && npm run build
cd ../cli && npm ci && npm run typecheck && npm run build && npm test
```

Or from the repository root, `make cli`.
