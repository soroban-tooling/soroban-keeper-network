---
title: "docs(deploying): add a troubleshooting section covering the common deploy failures"
labels: [docs, good-first-issue]
epic: E20
wave: 1
depends_on: []
---

## Summary

`docs/DEPLOYING.md` documents the happy path. Every step in it can fail in a small number of predictable ways, and none of those failures are documented. Someone deploying for the first time hits one, gets a raw CLI error, and has nowhere to look.

## Expected behaviour

A Troubleshooting section lists the failures people actually hit, with the error text they will see and the fix.

## What to cover

Work from the real failure modes rather than inventing them. The deploy path is: install the CLI, generate and fund a key, build, optimize, deploy, initialize. Each stage has characteristic failures.

**Account not funded.** `stellar keys fund` against testnet fails intermittently when Friendbot is rate-limited or down. The resulting error at deploy time complains about a missing account rather than a funding failure, which sends people looking in the wrong place. Document how to verify the balance directly and how to retry.

**Wrong network.** Deploying against testnet with a mainnet passphrase configured, or vice versa. Produces confusing signature or account errors. Document how to check the active network configuration.

**WASM too large.** The unoptimized artifact can exceed the network's contract size limit. The fix is `stellar contract optimize`, which `scripts/optimize.sh` and `make optimize` already wrap — but the connection between the error and that command is not obvious. Include the size limit and how to check the artifact size before deploying.

**`initialize` called twice.** Returns `AlreadyInitialized` (error 1). Common when a deploy script is re-run after a partial failure. Explain that redeploying produces a new contract ID and that the old one is still initialized — which is the actually confusing part.

**Deploy succeeded but `initialize` failed.** Leaves a live contract that reverts on nearly every entry point. Worth its own note, because the contract looks deployed and is not usable. Explain how to detect it — `admin()` returns `None` — and that the fix is simply calling `initialize`.

**Reward token address.** `initialize` takes the SAC address for the reward asset. Getting the native XLM SAC address for a given network is non-obvious and network-specific. Give the command that derives it.

**Insufficient balance for the escrow.** `register_task` transfers the reward from the owner at registration. If the owner has not funded or has not established a trustline for a non-native asset, the transfer fails inside the contract call and surfaces as a generic invocation failure.

**Stale CLI.** A `stellar-cli` older than the SDK version the contract targets produces obscure XDR errors. Document the minimum version and how to check it.

## Suggested approach

Use a consistent shape per entry: symptom (the actual error text), cause, fix. Put the error text first — that is what people paste into a search box, and it is what makes the section findable.

Reproduce each failure before documenting it. A troubleshooting guide written from imagination gets the error strings wrong, which makes it useless for exactly the search-and-match workflow it exists to serve. If you cannot reproduce one, leave it out and say so on the issue rather than guessing.

Cross-link from README's deployment section and from `scripts/deploy.sh` — a comment in the script pointing at the guide costs nothing and lands where someone is already looking.

## Acceptance criteria

- [ ] `docs/DEPLOYING.md` has a Troubleshooting section.
- [ ] Each entry gives the observed error text, the cause, and the fix.
- [ ] Every documented error string was reproduced, not guessed.
- [ ] The deploy-succeeded-but-initialize-failed case is covered, including how to detect it.
- [ ] Deriving the native SAC address per network is documented with a working command.
- [ ] Minimum `stellar-cli` version is stated with a version check command.
- [ ] README and `scripts/deploy.sh` link to the section.

## Files

- `docs/DEPLOYING.md`
- `README.md`
- `scripts/deploy.sh` — comment only

## Getting started

Good first issue if you are willing to deploy to testnet a few times and write down what breaks. Testnet XLM is free, so the only cost is patience.
