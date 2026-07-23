---
title: "feat(keeper-bot): validate configuration values at startup instead of failing mid-round"
labels: [keeper-bot, enhancement, good-first-issue]
epic: E15
wave: 1
depends_on: []
---

## Summary

`validateConfig` checks that three settings are non-empty and that the network name is known. It does not check that any value is well-formed, and it ignores the numeric settings entirely. Malformed input surfaces as a confusing failure later, sometimes several rounds in.

## Current behaviour

```js
function validateConfig() {
  if (!CONFIG.secretKey) { /* exit */ }
  if (!CONFIG.registryContractId) { /* exit */ }
  if (!NETWORK_CONFIG[CONFIG.network]) { /* exit */ }
}
```

## What gets through

**A malformed contract ID.** Any non-empty string passes. A typo, a truncated paste, or a mainnet ID while `NETWORK=testnet` all reach `new Contract(contractId)` and fail there with an SDK-level error, or worse, produce a valid-looking query against a contract that does not exist — which returns zero events and looks like a quiet network.

**A malformed secret key.** `Keypair.fromSecret` throws, but it is called in `main()` after the startup banner has printed the network and RPC URL. The user sees a successful-looking startup followed by an unhandled failure.

**A public key in the secret key slot.** Starts with `G` rather than `S`. Confusing to diagnose and easy to do.

**Every numeric setting.** `parseInt` returns `NaN` for garbage, and `NaN` propagates silently:

- `POLL_INTERVAL_MS=abc` gives `setInterval(fn, NaN)`, which Node coerces to 1 — a round every millisecond.
- `MAX_TASKS_PER_ROUND=0` disables the bot entirely, with no message.
- `MAX_RETRIES=-1` makes the retry loop never execute its body.
- `WITHDRAW_THRESHOLD=abc` throws inside `BigInt()` at module load, before `validateConfig` is even reached.

That last one is worth noting: it fails before any validation runs, so no amount of checking inside `validateConfig` will catch it.

**Network/contract mismatch.** A testnet contract ID against `NETWORK=mainnet` is well-formed and wrong. The bot runs, finds nothing, and reports a quiet network forever.

## Expected behaviour

Every configuration value is validated for format and range at startup. Failures name the variable, what was wrong, and what a valid value looks like. Nothing is validated after the first round begins.

## Suggested approach

Validate format using the SDK rather than hand-rolled regexes — `StrKey` knows the encoding and checksum rules:

```js
const { StrKey } = require("@stellar/stellar-sdk");

if (!StrKey.isValidContract(CONFIG.registryContractId)) {
  fail("REGISTRY_CONTRACT_ID", CONFIG.registryContractId,
       "a contract ID starting with C, e.g. CDJOYHBS7C2PVJS47BTRDLGBNG2YOE43VX6Y3EWIZPPPKOPRNYQQ54U4");
}
if (!StrKey.isValidEd25519SecretSeed(CONFIG.secretKey)) {
  // Never print the value itself.
  fail("KEEPER_SECRET_KEY", null, "a secret seed starting with S");
}
```

**Never echo the secret key** in an error message, not even partially. Write a `fail` helper that takes the value optionally and omits it for anything secret, so the rule is enforced in one place rather than remembered at each call site.

Move the numeric parsing into a validated helper and apply it to every numeric setting, with an explicit minimum:

```js
function requirePositiveInt(name, raw, { min = 1, max = Infinity, fallback }) { /* ... */ }
```

This also solves the `WITHDRAW_THRESHOLD` load-time crash, since parsing moves out of the `CONFIG` initialiser into a function that can report properly.

Finally, verify the contract actually exists on the configured network before starting the loop — a single `task_count` simulation is enough. That catches the network/ID mismatch, which is the failure mode most likely to waste an operator's afternoon, and it is the one check that no amount of format validation can replace.

## Acceptance criteria

- [ ] Contract ID and secret key are format-validated with `StrKey`.
- [ ] The secret key is never included in any log or error output.
- [ ] Every numeric setting is validated for type and range, with documented bounds.
- [ ] `WITHDRAW_THRESHOLD` no longer throws at module load on bad input.
- [ ] A startup reachability check confirms the contract exists on the configured network.
- [ ] Every error names the environment variable and describes a valid value.
- [ ] All validation happens before the banner claims a successful start.
- [ ] `.env.example` documents the valid range for each setting.

## Files

- `examples/keeper-bot/index.js`
- `examples/keeper-bot/.env.example`
