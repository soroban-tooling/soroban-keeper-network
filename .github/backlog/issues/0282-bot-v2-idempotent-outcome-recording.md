---
title: "test(keeper-bot-v2): outcome recording is idempotent under retried submissions"
labels: [keeper-bot, testing, intermediate]
epic: E15
wave: 3
depends_on: [0252, 0259]
---

## Summary

The persisted state schema from issue 0252 records outcomes as they happen. Combined with withRetry's retry logic and the degraded-mode handling from issue 0259, a submission whose result is ambiguous (the RPC call timed out but the transaction may have actually landed) is a real risk: recording it wrongly could either cause a needless re-attempt against an already-executed task or, worse, mask that execution never actually happened.

## Expected behaviour

Before recording an outcome as failed after a timeout, the bot checks on-chain state (via get_task) to determine what actually happened rather than trusting only the local call's exception, and outcome recording itself is written so a duplicate recording attempt for the same task id and action is a no-op rather than a second conflicting entry.

## Acceptance criteria

- [ ] A timed-out submission whose transaction actually landed is correctly recorded as successful after an on-chain check, not marked failed.
- [ ] Recording the same outcome twice (a retried recording after a crash between submission and persistence) does not corrupt the stored state.
- [ ] A test simulates exactly this ambiguous-timeout scenario and confirms the final recorded state matches on-chain truth.

## Files

- (v2 package)/src/state/outcomes.*
