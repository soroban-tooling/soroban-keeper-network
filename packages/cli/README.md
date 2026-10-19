# skn

A command-line tool for the Soroban Keeper Network, built on
[`@soroban-keeper-network/sdk`](../sdk-ts). It lets an operator act as a
keeper by hand and inspect the registry without writing a script.

```console
$ skn config init
$ export SKN_SECRET_KEY=S...            # or --key-file / --identity, see below
$ skn task claim 7 --contract-id C...
Claimed task 7 as GABC...
Lock expires at ledger 51290 (90 ledgers from ledger 51200, about 7m 30s).
Execute before the lock expires: skn task execute 7 --proof <hex>
$ skn task execute 7 --proof 0xdeadbeef --contract-id C...
Executed task 7 as GABC...
Reward credited: 4750000 (task reward 5000000, protocol fee 250000 at 500 bps).
It is withdrawable now with withdraw_rewards.
```

`skn --help` lists every command group and `skn <command> --help` describes
each command. `skn --version` prints the CLI version, the SDK version and the
keeper-registry contract versions this release supports.

## Commands

| Command | What it does |
| --- | --- |
| `skn task claim <task-id>` | Claims a task as the signing key's account and reports the ledger its lock expires at. |
| `skn task execute <task-id> --proof <hex>` | Submits a proof for a claimed task and reports the reward credited. `--proof-file <path>` reads the hex from a file instead. |
| `skn config init [--force]` | Writes a config file with `testnet`, `futurenet` and `mainnet` profiles. |
| `skn config show` | Prints the effective settings and where each one came from. |

The `keeper`, `admin`, `batch`, `deploy` and `events` groups are listed but
not implemented yet.

A proof is always read as hex (an optional `0x` prefix is allowed), following
the SDK's `toProofBytes` rules. Text is rejected rather than guessed at, and a
proof over the contract's 256-byte limit is rejected before anything is sent.

## Configuration and profiles

Settings are resolved in this order, highest precedence first:

1. flags: `--rpc-url`, `--network-passphrase`, `--contract-id`;
2. the selected profile in the config file;
3. defaults from the SDK's `NETWORK_PRESETS` for the profile's `network`
   (or for the profile's own name, if that is `testnet`, `futurenet` or
   `mainnet`), otherwise testnet.

The profile is picked by `--profile`, else the file's `defaultProfile`, else
`testnet`. Without a config file the three built-in profiles are still
available.

The config file is `--config <path>`, else `$SKN_CONFIG`, else
`$XDG_CONFIG_HOME/skn/config.json` (`~/.config/skn/config.json`), or
`%APPDATA%\skn\config.json` on Windows:

```json
{
  "defaultProfile": "testnet",
  "profiles": {
    "testnet": {
      "network": "testnet",
      "rpcUrl": "https://soroban-testnet.stellar.org",
      "networkPassphrase": "Test SDF Network ; September 2015",
      "contractId": "C..."
    }
  }
}
```

Unknown keys are rejected, so a typo such as `contractID` is reported rather
than ignored. The config file never holds keys.

### Mainnet

A command that sends a transaction refuses to run against mainnet unless
`--confirm-mainnet` is given. Mainnet is recognized by its network
passphrase, not by the profile's name, so a profile called `prod` that points
at mainnet still needs the flag. The check runs before any key is loaded or
any request is made.

## Signing keys

Keys come from one of three sources. Highest precedence first:

1. **`--key-file <path>`**: a file containing one `S...` secret seed
   (surrounding whitespace is ignored). On Linux and macOS the file must not
   be readable, writable or executable by group or other users, or `skn`
   refuses it; fix it with `chmod 600 <path>`. On Windows, POSIX mode bits do
   not describe who can read a file, so this check is skipped and you should
   restrict the file's ACL yourself.
2. **`--identity <name>`**: a [Stellar CLI](https://developers.stellar.org/docs/tools/cli)
   identity (`stellar keys generate <name>`). It is looked up in
   `./.stellar/identity/`, then `$STELLAR_CONFIG_HOME/identity/`, then
   `~/.config/stellar/identity/`, then the legacy `soroban` locations.
   Identities that hold a seed phrase or live in the OS keychain have no
   `secret_key` entry, so they cannot be used. Use one of the other sources
   instead.
3. **`SKN_SECRET_KEY`**: an environment variable holding the secret seed.

Passing both `--key-file` and `--identity` is an error. Secrets are never
accepted as command-line arguments, because arguments end up in shell
history and process listings. An argument that looks like a secret seed is
refused before it is parsed.

A key never appears in `skn`'s output, logs or error messages. Errors name
the source (for example "key file /path" or "SKN_SECRET_KEY"), never the
value, and all output goes through a redactor that masks every key loaded.
The test suite runs every command, with each key source, through success,
contract-error and usage-error paths, and checks that the secret is absent.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Success. |
| 1 | Unexpected failure. |
| 2 | Usage error: bad arguments, config or key. Nothing was sent. |
| 3 | The contract rejected the call, including a lost claim race or an expired deadline. |
| 4 | RPC failure: the call never reached a contract verdict. Often worth retrying. |

## Development

The package depends on the SDK through `file:../sdk-ts`, so build the SDK
first:

```sh
(cd ../sdk-ts && npm ci && npm run build)
npm ci
npm run build
npm test
npm run lint
```

Tests run each command in-process against the SDK's own fake RPC
(`packages/sdk-ts/test/support/fakeRpc.ts`), with real XDR encoding and no
network access.
