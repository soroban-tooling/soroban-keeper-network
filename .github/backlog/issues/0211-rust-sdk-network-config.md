---
title: "feat(rust-sdk): named network presets for testnet, futurenet, and mainnet"
labels: [rust-sdk, enhancement, good-first-issue]
epic: E13
wave: 3
depends_on: [0198]
---

## Summary

The keeper-bot's NETWORK_CONFIG map (index.js) already carries the RPC URL and network passphrase for testnet, futurenet, and mainnet. The Rust SDK needs the equivalent so a native application does not have to hardcode Stellar's network passphrase strings.

## Expected behaviour

An enum or set of named constants providing the RPC URL and network passphrase for each of the three networks, used as the default when constructing a client, with an explicit override path for a custom RPC endpoint (self-hosted node, a regional provider) without forking the crate.

## Acceptance criteria

- [ ] Testnet, futurenet, and mainnet presets match the values already in the keeper-bot's NETWORK_CONFIG exactly, not independently re-derived.
- [ ] A custom RPC URL can be supplied without needing a fourth preset variant for every private node an integrator might run.
- [ ] Rustdoc states which network each preset targets and links to Stellar's own documentation for the passphrases rather than asserting they will never change.

## Files

- rust-sdk/src/network.rs
