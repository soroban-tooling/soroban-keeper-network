---
title: "chore(ci): add the treasury contract to the pipeline"
labels: [tooling, contract, good-first-issue]
epic: E08
wave: 4
depends_on: [0339]
---

## Summary

Extends the required/advisory CI split docs/CI.md documents to cover the treasury contract's build, format, and test jobs, following the same pattern the registry itself uses.

## Acceptance criteria

- [ ] Treasury contract build, test, and WASM output are covered by CI on relevant PRs.
- [ ] Format and clippy follow the same required/advisory split as the registry.
- [ ] Documented in docs/CI.md.

## Files

- .github/workflows/ci.yml
- docs/CI.md
