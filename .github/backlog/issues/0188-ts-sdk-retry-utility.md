---
title: "feat(sdk-ts): reusable retry/backoff utility, extracted from the keeper-bot pattern"
labels: [enhancement, good-first-issue]
epic: E12
wave: 3
depends_on: [0151]
---

## Summary

`examples/keeper-bot/index.js`'s `withRetry` (exponential backoff plus jitter, distinguishing permanent from transient errors via `isPermanentError`) is generically useful to any SDK consumer submitting transactions against a network that has occasional transient RPC failures, not just to the reference bot. This issue lifts that logic into the SDK as a reusable, exported utility.

## Expected behaviour

An exported `withRetry(fn, options)` and `isPermanentError(err)` (or an equivalent classification helper informed by the typed error decoding from issue 0166, so "permanent" can mean "a decodable, non-retryable KeeperError" rather than just string-matching an error message the way the current bot example does), usable both internally by the SDK's own submission path and externally by any consumer.

## Acceptance criteria

- [ ] Behavior matches the existing keeper-bot's retry semantics (exponential backoff with jitter, configurable max retries) as a starting baseline, improved where the typed-error decoder makes a better classification possible.
- [ ] The SDK's own transaction submission (issue 0170) uses this utility internally rather than duplicating retry logic.
- [ ] Exported for external use, with its own tests independent of any specific method.

## Files

- packages/sdk-ts/src/retry.ts
