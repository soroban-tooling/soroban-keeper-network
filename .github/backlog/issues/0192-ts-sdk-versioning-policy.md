---
title: "docs(sdk-ts): versioning policy tying SDK releases to contract VERSION"
labels: [docs, good-first-issue]
epic: E12
wave: 3
depends_on: [0166]
---

## Summary

Several issues in this epic (0154, 0157, 0163, 0166) explicitly depend on the SDK's copies of contract constants and error codes staying in sync with `contracts/keeper-registry/src/lib.rs`'s actual `VERSION`. This issue writes down the policy those issues assume exists: how does an SDK release map to a contract version, and what breaks if they drift.

## Expected behaviour

A documented policy (semver-independent SDK versioning with an explicit compatibility table mapping SDK version ranges to supported contract `VERSION` values, most likely -- but confirm this is actually the right model rather than assuming it) plus a runtime check (building on issue 0164's `version()` wrapper) that warns when the SDK talks to a contract outside its declared compatible range.

## Acceptance criteria

- [ ] A compatibility table format is chosen and documented.
- [ ] The runtime version-mismatch warning from issue 0164 is specified precisely enough to implement against.
- [ ] CHANGELOG.md (the SDK's own, likely `packages/sdk-ts/CHANGELOG.md`, separate from the contract's) documents which contract VERSION each SDK release targets.

## Files

- packages/sdk-ts/VERSIONING.md
- packages/sdk-ts/CHANGELOG.md
