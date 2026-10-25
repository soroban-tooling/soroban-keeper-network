# skn, the command-line tool

`skn` (`packages/cli`) drives the keeper-registry contract from a terminal. It
is a thin layer over the TypeScript SDK (`packages/sdk-ts`), so it encodes
arguments, validates them and decodes contract errors exactly as the SDK does.

```bash
npx skn --help
npm install --global skn   # or install it globally
```

## Commands

| Command | What it does |
|---------|--------------|
| `skn task register` | Register a task and escrow its reward. Prices the transaction first, shows the fee, then asks to confirm. |
| `skn admin show` | Read the registry's admin, pause state, fee and reward floor. No key needed. |
| `skn admin pause` / `unpause` | Pause or resume the registry. |
| `skn admin set-fee-bps <bps>` | Set the protocol fee, 0 to 10000 basis points. |
| `skn admin set-min-reward <amount>` | Set the smallest reward a task may be registered with. |
| `skn events watch` | Stream contract events, one line each. |

The two-signature admin controls (`transfer-admin`, `sweep-fees`, `upgrade`) and
the keeper, batch and deploy groups are not implemented yet.

## Connecting

Each setting comes from a flag, then an environment variable, then a default.

| Flag | Environment | Default |
|------|-------------|---------|
| `--network` | `SKN_NETWORK` | `testnet` (also `futurenet`, `mainnet`) |
| `--rpc-url` | `SKN_RPC_URL` | the network preset's RPC URL |
| `--passphrase` | `SKN_NETWORK_PASSPHRASE` | the network preset's passphrase |
| `--contract-id` | `SKN_CONTRACT_ID` | required |
| `--key-file` | `SKN_SECRET_KEY` | required for commands that sign |
| `--indexer-url` | `SKN_INDEXER_URL` | none (`events watch` polls RPC) |

The key is a Stellar secret seed (`S...`), read from the file or the variable.
There is deliberately no flag that takes the key itself: a value on the command
line lands in shell history and `ps`. The key is never printed, and is scrubbed
from any error message.

## Output and exit codes

Results go to stdout and diagnostics (fee previews, warnings, errors) to stderr,
so output can be piped. With `--json`, stdout carries one JSON document per
result (one per line for `events watch`) and stderr carries a JSON error object
on failure: `{"error": {"code": "InvalidReward", "message": "...", "exitCode": 3}}`.
Amounts are decimal strings, because an `i128` can exceed what a JSON number holds.

| Exit code | Meaning |
|-----------|---------|
| 0 | Success |
| 1 | Failure, or the confirmation prompt was declined |
| 2 | Usage error: a bad flag, a missing input, no key, or no way to confirm |
| 3 | The contract rejected the call (`code` names the error, e.g. `Unauthorized`) |
| 4 | Network or RPC failure before the contract gave a verdict |

## Sending transactions

Every state-changing command simulates the call first and prints the estimated
fee on stderr, then asks `Submit <method> to <network>? [y/N]`. `--yes` approves
in advance. With no terminal, or with `--json`, a command without `--yes`
refuses to send rather than guess.

### skn task register

```bash
skn task register --type liquidation --reward 10000000 --deadline +2h \
  --ttl-ledgers 20000 --lock-ledgers 120 [--calldata <hex>] [--verifier <C...>] --yes
```

`--deadline` takes a relative duration (`+2h`, `+1d12h`; units `s m h d w`), an
ISO timestamp with an explicit offset (`2026-12-01T10:00:00Z`), a date
(`2026-12-01`, midnight UTC), or Unix seconds. A timestamp without an offset is
refused rather than read in the local zone. `--type` takes a name
(`liquidation`, `oracle-price-push`, `funding-rate-update`, `liquidity-rebalance`,
`ttl-extension`, `custom`) or the contract's number. `--calldata` is the opaque
hex bytes the keeper receives; the contract does not define their layout.

`--file <path>` supplies any of `type`, `calldata`, `reward`, `deadline`,
`ttlLedgers`, `lockLedgers`, `verifier` from a JSON object; a flag overrides the
file. The owner is always the signing key's address.

## Watching events

```bash
skn events watch [--type task_registered] [--task 7] [--json] [--count 10]
```

With an indexer URL (`--indexer-url` or `SKN_INDEXER_URL`) the command streams
the indexer's WebSocket at `/v1/stream` and reconnects from the last cursor it
saw. Without one, or on a runtime with no WebSocket (Node before 22), it polls
`getEvents` every `--interval` milliseconds, starting at the latest ledger or at
`--from-ledger`. Both feeds print the same fields:

```
ledger=100 task_registered task_id=7 owner=GABC... reward=1000 deadline=1900000000 tx=ab12...
```

`--type` accepts an event name (`task_registered`, `TaskRegistered`) or the
contract's topic verb (`reg`), and `--task` a task ID; both filter on the CLI
side as well as asking the server. `--count` stops after that many events, and
Ctrl-C stops a watch cleanly.

## Testing

```bash
make cli                       # from the repository root, builds sdk-ts first
cd packages/cli && npm test    # vitest, once packages/sdk-ts and the CLI are installed
```

`test/support/harness.ts` runs the real command tree with a `FakeRpc` from the
SDK's test support, a scripted WebSocket and a captured stdout/stderr. Each
command has a success test, a contract-error test and a `--json` test.

## Releasing

Publishing is automated by `.github/workflows/cli-publish.yml`, triggered by a
`cli-vX.Y.Z` tag.

```bash
cd packages/cli
npm version 0.2.0 --no-git-tag-version   # then set CLI_VERSION in src/version.ts to match
git tag -a cli-v0.2.0 -m "cli v0.2.0"
git push origin cli-v0.2.0
```

The workflow refuses to publish when the tag does not match `package.json`'s
version or `CLI_VERSION`, or when the SDK version the CLI builds against is not
on npm. It needs a `CLI_NPM_TOKEN` secret in the `npm-publish` environment. In
the repository the CLI links the SDK with `file:../sdk-ts`; the workflow pins
that to the SDK's published version just before `npm publish`.
