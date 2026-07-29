---
title: "docs: migration guide for dApps integrated against the pre-verifier ABI"
labels: [docs, good-first-issue]
epic: E04
wave: 2
depends_on: [0073, 0096]
---

## Summary

Issue 0073 changes register_task's arity (adds the verifier parameter), a breaking ABI change per issue 0096's VERSION bump. Any dApp already integrated against the pre-epic-E04 contract needs a clear path to update, beyond just reading the CHANGELOG diff.

## Expected behaviour

A short migration section (in docs/VERIFIERS.md or CHANGELOG.md directly) showing the before/after register_task call signature side by side, stating plainly that passing None preserves exactly the old behavior, and noting any other ABI surface this epic touched that an integrator should check (new error variants that existing error-handling switch statements should account for, even if only to fall through to a default case).

## Acceptance criteria

- [ ] Before/after call signature shown explicitly.
- [ ] Confirms and states that None is a behavior-preserving no-op for existing integrations.
- [ ] Lists every new KeeperError variant this epic added, so an integrator's error handling can be reviewed against the full new list.

## Files

- docs/VERIFIERS.md
- CHANGELOG.md
