---
title: "feat(keeper-bot-v2): CLI commands to inspect a running bot's state"
labels: [keeper-bot, enhancement, intermediate]
epic: E15
wave: 3
depends_on: [0252, 0257]
---

## Summary

Beyond the metrics endpoint from issue 0257, an operator debugging a specific decision (why was this task skipped, what is the persisted state for this task id) needs a direct way to query the running bot rather than reconstructing the answer from logs.

## Expected behaviour

A small set of CLI subcommands (or an admin HTTP endpoint, whichever fits the package's actual architecture from issue 0250) exposing: current persisted state for a given task id, a dump of current configuration values (with secrets redacted), and recent skip decisions with reasons.

## Acceptance criteria

- [ ] Each stated inspection capability is available.
- [ ] Configuration dump redacts the signing key and any other secret, matching the secret-hygiene discipline v1's requireEnv already established.
- [ ] Works against a live running instance without requiring a restart to enable inspection.

## Files

- (v2 package)/src/cli.*
