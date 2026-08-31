---
title: "feat(keeper-bot-v2): degrade gracefully during an extended RPC outage"
labels: [keeper-bot, enhancement, intermediate]
epic: E15
wave: 3
depends_on: [0250]
---

## Summary

v1's withRetry handles a single transient failure with backoff, but has no distinct behavior for an outage lasting well beyond a few retries (an RPC provider down for minutes, not seconds). A competitive keeper needs to know the difference between "briefly slow" and "unavailable," since retrying an unavailable endpoint at the same aggressive cadence wastes cycles and may itself contribute to the provider's load.

## Expected behaviour

After a configurable number of consecutive fully-exhausted retry sequences, the bot enters a distinct degraded mode with a longer polling interval and triggers the alerting from issue 0258, recovering to normal operation once a call succeeds again.

## Acceptance criteria

- [ ] Degraded mode is entered only after genuinely exhausting retries repeatedly, not on a single transient failure.
- [ ] Degraded mode uses a longer interval and is exited automatically on recovery.
- [ ] An alert fires on entry to degraded mode, not silently.

## Files

- (v2 package)/src/loop.*
