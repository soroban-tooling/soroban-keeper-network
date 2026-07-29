---
title: "chore(ci): track WASM size against a committed baseline, not just an absolute number"
labels: [tooling, good-first-issue]
epic: E05
wave: 2
depends_on: []
---

## Summary

The existing wasm-size advisory CI job (from wave 1's pipelines PR) reports the current binary size on every PR but has nothing to compare it against except a reviewer's memory of what the number usually is. This issue adds a committed baseline file so the job can report a delta, not just an absolute figure.

## Expected behaviour

A small baseline file (e.g. .github/wasm-size-baseline.txt) tracking the last-known-good optimized WASM size. The wasm-size job reads it, computes the delta for the current PR, and includes both the absolute size and the delta (with a percentage) in its job summary. Update instructions for the baseline file are documented for maintainers merging a PR that intentionally grows the contract.

## Acceptance criteria

- [ ] Job summary shows both absolute size and delta from baseline.
- [ ] A PR that grows the WASM size by more than a documented threshold (pick a reasonable percentage, justify it) gets a visibly flagged warning in the summary -- still advisory, never blocking, consistent with the job's existing continue-on-error policy.
- [ ] Baseline update process is documented in docs/CI.md.

## Files

- .github/workflows/ci.yml
- .github/wasm-size-baseline.txt
- docs/CI.md
