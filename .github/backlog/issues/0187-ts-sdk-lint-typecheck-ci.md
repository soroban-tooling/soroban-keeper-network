---
title: "chore(ci): lint and typecheck job for the TypeScript SDK"
labels: [tooling, good-first-issue]
epic: E12
wave: 3
depends_on: [0151]
---

## Summary

Mirrors the existing `Lint & Format` and `Clippy` required/advisory split from the Rust side of this repository's CI, for the new TypeScript package -- `tsc --noEmit` and ESLint should run on every PR touching `packages/sdk-ts/`.

## Expected behaviour

A CI job running `tsc --noEmit` (required -- a type error should block merge, consistent with how `Format (required)` treats `cargo fmt --check` on the Rust side) and ESLint (advisory, consistent with `Clippy (advisory)`'s existing precedent of not blocking on subjective lint findings) against the SDK package.

## Acceptance criteria

- [ ] Typecheck failure blocks the PR; lint failure does not, matching the existing required/advisory split documented in docs/CI.md.
- [ ] docs/CI.md is updated to list these new jobs alongside the existing ones.
- [ ] Uses the same eslint.config.js flat-config pattern established for examples/keeper-bot (wave-1 issue 0036), not a separate legacy .eslintrc.

## Files

- .github/workflows/ci.yml
- docs/CI.md
- packages/sdk-ts/eslint.config.js
