---
title: "feat(sdk-ts): network configuration presets for testnet/futurenet/mainnet"
labels: [enhancement, good-first-issue]
epic: E12
wave: 3
depends_on: [0151]
---

## Summary

`examples/keeper-bot/index.js`'s `NETWORK_CONFIG` object hardcodes RPC URLs and network passphrases per network name. This is exactly the kind of small, easily-gotten-wrong-by-hand configuration an SDK should provide as a built-in convenience, so a consumer does not need to look up and hardcode a passphrase string themselves.

## Expected behaviour

An exported `NETWORK_PRESETS` (or a `network: "testnet" | "futurenet" | "mainnet"` shorthand accepted directly by the `KeeperRegistryClient` constructor from issue 0153, resolved internally to the right RPC URL and passphrase) mirroring the keeper-bot's existing table, kept in one place so a future network config change (a new default RPC endpoint, for instance) is a one-line update rather than a hunt across every consumer's codebase.

## Acceptance criteria

- [ ] All three networks covered with correct, verified (not guessed) RPC URLs and passphrases.
- [ ] `KeeperRegistryClient` accepts either the shorthand or fully explicit `{ rpcUrl, networkPassphrase }`, for consumers on a custom or private network.
- [ ] Documented as the recommended default in the quickstart (issue 0182).

## Files

- packages/sdk-ts/src/networks.ts
