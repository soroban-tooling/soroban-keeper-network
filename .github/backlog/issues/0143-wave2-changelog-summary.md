---
title: "chore(release): consolidated CHANGELOG summary for wave 2's shipped work"
labels: [docs, good-first-issue]
epic: E05
wave: 2
depends_on: [0096, 0117]
---

## Summary

Issues 0096 and 0117 each add their own CHANGELOG entry for their respective epic's shipped ABI changes. This issue is a lighter editorial pass once both have landed: confirm the entries read coherently together, in the right order, and that nothing from wave 2's actually-shipped code (as opposed to the docs-only or fuzzing/testing issues, which do not need CHANGELOG entries) was missed.

## Expected behaviour

A single pass over CHANGELOG.md's Unreleased section (or the released section, if a release has been cut by this point) confirming every shipped, user-visible change from wave 2 is represented exactly once, without duplication between issue 0096's and issue 0117's entries.

## Acceptance criteria

- [ ] No shipped ABI change from wave 2 is missing from CHANGELOG.md.
- [ ] No entry is duplicated or contradicts another.
- [ ] Entries are ordered sensibly (chronologically or by epic, pick one and be consistent).

## Files

- CHANGELOG.md
