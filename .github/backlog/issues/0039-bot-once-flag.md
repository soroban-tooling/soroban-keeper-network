---
title: "feat(keeper-bot): add a --once flag to run a single round and exit"
labels: [keeper-bot, enhancement, good-first-issue]
epic: E15
wave: 1
depends_on: []
---

## Summary

The bot can only run as a daemon. `main()` runs a round and then installs a `setInterval` that never stops except on a signal. There is no way to execute exactly one round and exit with a meaningful status code.

## Current behaviour

```js
// Run initial round immediately, then poll.
await runRound();
timer = setInterval(runRound, CONFIG.pollIntervalMs);
```

The only exits are `process.exit(0)` from the shutdown handler and `process.exit(1)` from the fatal error handler. A one-shot run means starting the bot, waiting, and sending SIGINT — and the exit code is 0 regardless of whether the round accomplished anything or errored.

## Why a one-shot mode is worth having

**Cron and serverless.** Not every keeper wants a long-lived process. A scheduled invocation is a legitimate and often cheaper deployment shape, and it needs a process that exits.

**Testing and CI.** There is currently no way to exercise the bot end to end in an automated test. A single round with a definite exit code is the difference between a testable program and one that can only be run by hand. The separate bot test-suite issue depends on this.

**Operator diagnostics.** "Did my configuration work?" currently requires reading log output and interrupting. `--once` with a non-zero exit on failure answers it directly.

**Debugging.** Reproducing a problem in a loop that keeps moving is harder than reproducing it in one round.

## Expected behaviour

`node index.js --once` runs exactly one round, exits 0 on success and non-zero on failure, and installs no interval timer.

## Suggested approach

Support both a flag and an environment variable, since cron and container environments differ in which is convenient:

```js
const CONFIG = {
  // ...
  once: process.argv.includes("--once") || process.env.RUN_ONCE === "true",
};
```

Then branch before installing the timer:

```js
if (CONFIG.once) {
  // One round, definite exit code. Nothing is scheduled, so the process ends
  // when the round settles.
  const ok = await runRound();
  console.log(ok ? "✅  Round complete." : "⚠️  Round completed with errors.");
  process.exit(ok ? 0 : 1);
}

await runRound();
timer = setInterval(runRound, CONFIG.pollIntervalMs);
```

`runRound` currently returns nothing and swallows errors into a `console.error`. Have it return a boolean, or a small summary object, so the exit code can reflect what happened. Keep the swallowing behaviour for daemon mode — a single bad round should not kill a long-running bot — but let one-shot mode see the outcome.

Decide what counts as failure and write it down. A round where no tasks were available is a success, not a failure. A round where the RPC was unreachable is a failure. A round where one claim lost a race to another keeper is arguably neither — recommend treating it as success, since losing races is normal operation.

That decision is the substance of this issue; the flag parsing is trivial. Put the reasoning in a comment.

## Acceptance criteria

- [ ] `--once` and `RUN_ONCE=true` both trigger single-round mode.
- [ ] One-shot mode installs no interval timer and exits on its own.
- [ ] Exit code is 0 on success and non-zero on failure.
- [ ] What constitutes failure is documented in a comment, including the no-tasks and lost-race cases.
- [ ] Daemon mode behaviour is unchanged, including signal handling.
- [ ] `--help` describes the flag, or the header comment does.
- [ ] The operator guide documents the cron use case with an example crontab line.

## Files

- `examples/keeper-bot/index.js`
- `examples/keeper-bot/.env.example`
- `docs/DEPLOYING.md`
