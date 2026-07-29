---
title: "chore(ci): npm publish workflow for the TypeScript SDK"
labels: [tooling, intermediate]
epic: E12
wave: 3
depends_on: [0151, 0192]
---

## Summary

Once the SDK is usable (a reasonable point after the core client methods and error/event decoding exist), it needs an actual publishing pipeline rather than being buildable-but-unpublished forever.

## Expected behaviour

A GitHub Actions workflow triggered on a version tag (or a dedicated release-please-style automation, if that fits the project's existing release conventions better — check `docs/DEPLOYING.md` and any existing release workflow for precedent before inventing a new pattern) that builds, tests, and publishes the package to npm under the scoped name from issue 0151.

## Acceptance criteria

- [ ] Publish only runs on an explicit release trigger, never automatically on every merge to main.
- [ ] Publish is preceded by the full test suite (both unit and, at minimum, a smoke-level integration check) as a hard gate — an SDK publish should never skip tests the way an advisory CI job might.
- [ ] npm publish uses a scoped, revocable token (documented setup instructions for whoever configures repository secrets), not a personal account token.

## Files

- .github/workflows/sdk-ts-publish.yml
