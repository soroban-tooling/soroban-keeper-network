# @soroban-keeper-network/sdk

Typed TypeScript client for the Soroban Keeper Network `keeper-registry`
contract. This package is currently a **scaffold** (backlog 0151 / epic
E12): it ships build tooling, a `tsconfig.json`, and a placeholder export
so the ESM/CJS/`.d.ts` pipeline is proven end to end. The
`KeeperRegistryClient` and its per-entry-point methods land in the rest of
epic E12's issues.

## Workspace tooling decision

This package is a **standalone npm package**, not an npm/pnpm workspace
member — there is no root `package.json` in this repository. This matches
the existing convention for `examples/keeper-bot` and
`examples/batch-register`, which are each installed and built independently
with their own `node_modules`. Adopting workspaces would be a repo-wide
change affecting those packages too, which is out of scope for this
scaffold; it can be revisited later if the growing number of `packages/`
and `examples/` entries makes standalone installs unwieldy.

## Quick start

```bash
cd packages/sdk-ts
npm install
npm run build   # emits dist/cjs (CommonJS), dist/esm (ESM), and .d.ts declarations
npm test        # builds, then runs the require()/import smoke tests
```

## API reference

Generated from this package's TSDoc comments via
[TypeDoc](https://typedoc.org/) (config: `typedoc.json`), so every exported
method, hook, and type contributes to the reference automatically by having
a good doc comment — no separate documentation PR needed per method.

```bash
npm run docs        # generates HTML into docs/reference/ (gitignored — a build artifact, not source)
npm run docs:check  # generates with warnings treated as errors; fails if any exported symbol is undocumented
```

`docs:check` is wired into CI (`.github/workflows/ci.yml`'s `sdk-ts-docs`
job) as an **advisory** check — it reports doc-comment regressions in the
job summary but never blocks a PR, consistent with this repo's advisory-vs-required
CI policy (see `docs/CI.md`).

**Output and publishing:** HTML, generated on demand and gitignored — not
committed to this repo, and not yet published anywhere (e.g. GitHub Pages).
Publishing the generated output is explicitly out of scope for now; this
can be revisited once the SDK's surface is large enough to be worth
browsing outside of a local `npm run docs`.

## Layout

- `src/index.ts` — package entry point.
- `tsconfig.json` — shared compiler options.
- `tsconfig.cjs.json` / `tsconfig.esm.json` — per-target build configs.
- `typedoc.json` — TypeDoc config for the generated API reference.
- `test/` — `node --test` smoke tests, one exercising `require()` and one
  exercising `import`, against the built `dist/` output.
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
