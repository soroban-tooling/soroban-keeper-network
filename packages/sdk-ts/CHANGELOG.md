# Changelog

All notable changes to `@soroban-keeper-network/sdk` are documented here.
See [VERSIONING.md](./VERSIONING.md) for how a release's version relates to
the contract `VERSION`(s) it supports.

## 0.1.0 — Initial release

Targets contract `VERSION` **3** (see `contracts/keeper-registry/src/constants.rs`).

- `KeeperRegistryClient` — thin wrapper over `@stellar/stellar-sdk`'s Soroban
  RPC client, exposing `invoke()` (simulate → sign → submit → poll for a
  state-mutating call) and `read()` (simulation-only, for view functions),
  ported behavior-for-behavior from `examples/keeper-bot/index.js`'s
  hand-rolled `invokeContract`/`readContract`.
- `withRetry()` — exponential back-off with jitter, ported from the
  keeper-bot's own `withRetry`.
- `NETWORK_PRESETS` / `NetworkName` — testnet/futurenet/mainnet RPC URL and
  passphrase presets, matching the keeper-bot's `NETWORK_CONFIG`.
- `KeeperRegistryClient.version()`, `checkContractCompatibility()`,
  `compatibilityWarning()` — the version-compatibility runtime check
  described in VERSIONING.md.
