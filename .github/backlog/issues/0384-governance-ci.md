---
title: "chore(ci): add the token and governance contracts to the pipeline"
labels: [tooling, contract, good-first-issue]
epic: E09
wave: 4
depends_on: [0361, 0362]
---

## Summary

Extends CI to cover both new contracts, following the required/advisory split docs/CI.md documents for the registry and already extended to the treasury contract in issue 0356.

## Acceptance criteria

- [ ] Both contracts' build, test, and WASM output are covered on relevant PRs.
- [ ] Format and clippy follow the established required/advisory split.
- [ ] Documented in docs/CI.md.

## Files

- .github/workflows/ci.yml
- docs/CI.md
