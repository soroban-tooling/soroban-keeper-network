---
title: "test(keeper-bot): add a unit test suite with a mocked RPC layer"
labels: [keeper-bot, testing, intermediate]
epic: E15
wave: 1
depends_on: [0039]
---

## Summary

The keeper bot has no tests. Four hundred lines of retry logic, event decoding, deadline arithmetic, and shutdown handling are verified only by running it against a live network and watching the output.

## Current state

`examples/keeper-bot/` contains `index.js`, `package.json`, and `.env.example`. `package.json` has no `test` script. The CI bot job installs dependencies, syntax-checks, and lints — it never executes any logic.

The consequence is that every keeper-bot issue in this backlog is a change nobody can verify except by hand. That is the actual cost: the fix rate on this file is limited by how tediously each change must be checked.

## What is worth testing

Not everything. The bot's value is in a handful of decisions, and those are testable without a network:

**`isPermanentError`** is pure and already load-bearing — it decides whether a failed call is retried, and therefore whether the bot wastes fees. It matches on substrings of error messages, which is fragile in exactly the way tests catch. Every branch should be covered, plus a `null`/`undefined` error, which the current implementation guards against but nothing verifies.

**`withRetry`** is the backoff loop: retry counts, exponential growth, jitter bounds, and immediate bail-out on a permanent error. Testable with a fake clock and a function that fails a controlled number of times.

**Event decoding** in `fetchPendingTasks` — that a well-formed event produces the right task object, and that a malformed one is skipped and counted rather than crashing the round.

**Deadline logic** — the branch choosing between expire, skip, and claim. Pure comparison against `nowSeconds`, easy to pin down, and directly tied to whether the bot spends fees correctly.

**Configuration validation** — that each malformed value is rejected with a useful message, and that the secret key never appears in output. That last assertion is worth writing explicitly.

What is *not* worth mocking is the Stellar SDK's transaction construction. Testing that `TransactionBuilder` builds a transaction tests the SDK. Stop at the boundary: assert the bot calls the right contract method with the right arguments, not that the resulting XDR is correct.

## The obstacle

`index.js` exports nothing and calls `main()` on load, so requiring it from a test starts the bot. Making it testable means separating the module from its entry point:

```js
// Only start the bot when run directly, so tests can require this module
// without launching a polling loop.
if (require.main === module) {
  main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}

module.exports = { isPermanentError, withRetry, fetchPendingTasks, validateConfig, keeperLoop };
```

That refactor is most of the work and the prerequisite for everything else.

## Suggested approach

Use `node:test` and `node:assert` from the standard library. Node 18+ is already required by `package.json` engines, the bot has no test framework today, and adding jest or mocha to a deliberately-minimal example bot costs more than it returns. If you disagree, argue it on the issue before adding a dependency.

For the RPC, hand-write a small fake server object exposing only the handful of methods the bot calls — `getEvents`, `getLatestLedger`, `simulateTransaction`, `getAccount`, `getHealth`. A mocking library is unnecessary for five methods and makes the tests harder to read.

Depends on the `--once` flag issue: a single-round mode with a definite exit code is what makes an end-to-end smoke test possible.

## Acceptance criteria

- [ ] `index.js` can be required without starting the bot.
- [ ] `npm test` runs the suite using `node:test`.
- [ ] `isPermanentError` has every branch covered, including a null error.
- [ ] `withRetry` tests cover success-first-try, success-after-retries, exhausted retries, and immediate bail on a permanent error.
- [ ] Event decoding tests cover a well-formed event and a malformed one.
- [ ] The deadline branch is tested at its boundary.
- [ ] A test asserts the secret key never appears in validation output.
- [ ] The CI bot job runs `npm test`.
- [ ] No new production dependency is added.

## Files

- `examples/keeper-bot/index.js`
- `examples/keeper-bot/test/` — new
- `examples/keeper-bot/package.json`
- `.github/workflows/ci.yml`
