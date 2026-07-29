---
title: "docs(architecture): update the task lifecycle diagram to show the verifier callback"
labels: [docs, good-first-issue]
epic: E04
wave: 2
depends_on: [0074]
---

## Summary

The Task struct's doc comment in lib.rs includes an ASCII lifecycle diagram (PENDING -> CLAIMED -> EXECUTED, with cancel/expire branches). Epic E04 adds a step inside the CLAIMED -> EXECUTED transition (the verifier call) that the current diagram has no way to represent, since it predates the verifier concept entirely.

## Expected behaviour

Update the diagram (and its equivalent, if one exists, in docs/ARCHITECTURE.md) to show the verifier check as a branch point within the execute transition: CLAIMED --execute+verify(pass)--> EXECUTED, with a note that execute_task can also fail back to CLAIMED (retryable) on verifier rejection, distinct from the terminal failure states.

## Acceptance criteria

- [ ] Diagram accurately reflects that a verifier rejection returns to CLAIMED, not to a new or terminal state.
- [ ] Both the lib.rs doc comment and docs/ARCHITECTURE.md (if it duplicates the diagram) are updated consistently.

## Files

- contracts/keeper-registry/src/lib.rs
- docs/ARCHITECTURE.md
