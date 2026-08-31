# @soroban-keeper-network/sdk

TypeScript client for the Soroban Keeper Network's `KeeperRegistry`
contract.

## Install

Not yet published to npm. For now, reference it as a local path dependency
(see `examples/keeper-bot/package.json` for the pattern):

```json
{
  "dependencies": {
    "@soroban-keeper-network/sdk": "file:../../packages/sdk-ts"
  }
}
```

## Usage

```ts
import { KeeperRegistryClient, withRetry } from "@soroban-keeper-network/sdk";
import { Keypair } from "@stellar/stellar-sdk";

const client = new KeeperRegistryClient({
  contractId: "C...",
  network: "testnet",
  keypair: Keypair.fromSecret(process.env.KEEPER_SECRET_KEY!),
});

// State-mutating call: simulates, signs, submits, polls for confirmation.
await withRetry(
  () => client.invoke("claim_task", [/* ...ScVal args */]),
  { maxRetries: 3, retryBaseMs: 500 },
);

// Read-only view: simulation only, no signed transaction.
const balance = await client.read("keeper_balance", [/* ...ScVal args */]);
```

See [VERSIONING.md](./VERSIONING.md) for how this package's releases relate
to the contract's `VERSION`, and [CHANGELOG.md](./CHANGELOG.md) for release
notes.

## Network presets

`network: "testnet"` (recommended default — used throughout this README
and `examples/keeper-bot`) resolves internally to a verified `NetworkPreset`
(`rpcUrl` + `networkPassphrase`) via `NETWORK_PRESETS`. `"futurenet"` and
`"mainnet"` are the other two built-in presets. For a custom or private
network, pass a fully explicit preset instead of a name:

```ts
import { KeeperRegistryClient, type NetworkPreset } from "@soroban-keeper-network/sdk";

const localnet: NetworkPreset = {
  rpcUrl: "http://localhost:8000/soroban/rpc",
  networkPassphrase: "Standalone Network ; February 2017",
};

const client = new KeeperRegistryClient({
  contractId: "C...",
  network: localnet,
  keypair,
});
```

`NETWORK_NAMES` (the list of built-in preset names) and `isNetworkName()`
(a type guard for validating user-supplied network input, e.g. from an env
var or CLI flag) are also exported — see `src/network.ts` for the full
`NetworkPreset`/`NetworkName` types.

## Scope

This is a scaffold, not a full generated client: `invoke`/`read` are the
generic building blocks every specific `KeeperRegistry` call is built from,
not one hand-written method per contract function. `examples/keeper-bot`
is migrated onto this package as the first real consumer — see its
`index.js` for a complete usage example against every contract function the
bot calls.

## Development

```
npm install
npm run build   # compiles src/ to dist/
npm test        # compiles src/+test/ to dist-test/ and runs node --test
npm run lint
```
