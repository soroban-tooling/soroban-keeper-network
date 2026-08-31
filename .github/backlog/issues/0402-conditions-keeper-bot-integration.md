---
title: "feat(keeper-bot-v2): skip and reschedule tasks whose condition is not yet met"
labels: [keeper-bot, enhancement, intermediate]
epic: E10
wave: 4
depends_on: [0394, 0398, 0271]
---

## Summary

Once conditions exist, keeper-bot-v2 should use is_claimable's condition-aware result (issue 0394) to avoid wasting a submission on a task whose condition is currently false, and should use the ConditionNotMet event (issue 0398) as a signal to deprioritize that task rather than retrying it every round.

## Expected behaviour

The bot's candidate evaluation checks the condition-aware is_claimable before attempting a claim, and a task that has recently rejected on ConditionNotMet is deprioritized (not permanently excluded, since the condition may become true later) for a configurable backoff period, reusing the lock-window-aware scheduling pattern from issue 0271 for the general shape of "recheck this specific task later rather than every round."

## Acceptance criteria

- [ ] A task with a currently-false condition is not attempted, verified against a mock condition contract.
- [ ] A task that recently rejected is deprioritized for a configurable period, not retried every single round while its condition remains false.
- [ ] The bot correctly resumes attempting a task once its condition becomes true, verified by a test that flips a mock condition mid-run.

## Files

- examples/keeper-bot-v2/src/task_source.*
