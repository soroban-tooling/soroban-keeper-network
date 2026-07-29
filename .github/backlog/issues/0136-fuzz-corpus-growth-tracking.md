---
title: "chore(ci): track fuzz corpus growth over time as a signal the nightly job is doing useful work"
labels: [tooling, testing, good-first-issue]
epic: E03
wave: 2
depends_on: [0066]
---

## Summary

Issue 0066 wires a nightly fuzz job with a persistent, cached corpus. A corpus that never grows is a sign the fuzzer stopped finding new code paths (possibly because it already found everything reachable, or possibly because something is wrong with the harness) -- but nobody would notice either way without actively checking. This issue adds lightweight tracking so corpus growth (or its absence) is visible.

## Expected behaviour

The nightly fuzz job (issue 0066) reports corpus size (file count and total bytes) per target, before and after the run, in its job summary. A large, sustained plateau (corpus not growing across several consecutive nightly runs) is a signal worth a comment or a follow-up look, though this issue does not need to build automated alerting for it -- visibility in the summary is the deliverable.

## Acceptance criteria

- [ ] Job summary reports before/after corpus size per target on every nightly run.
- [ ] Documented in docs/CI.md (or the fuzzing guide from issue 0070) as a signal maintainers should glance at periodically.

## Files

- .github/workflows/fuzz-nightly.yml
- docs/CI.md
