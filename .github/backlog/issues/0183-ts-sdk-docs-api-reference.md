---
title: "docs(sdk-ts): generate and publish an API reference"
labels: [docs, tooling, good-first-issue]
epic: E12
wave: 3
depends_on: [0151]
---

## Summary

A hand-maintained API reference for a growing method/hook surface (roughly 25+ public exports by the end of this epic) will drift from the actual code quickly. This issue sets up generated documentation (TypeDoc or equivalent) from the source's own doc comments, so every method issue in this epic contributes to the reference automatically by having a good doc comment, rather than needing a separate documentation PR per method.

## Expected behaviour

A `docs` build script producing browsable HTML (or Markdown, if that fits this repository's existing docs/ convention better) from TSDoc comments across the package, wired into CI as an advisory build-check (does it generate without errors) even if publishing the output somewhere is out of scope for this issue.

## Acceptance criteria

- [ ] Every exported method, hook, and type has a TSDoc comment sufficient to produce a useful generated entry (parameter descriptions, return type, thrown/rejected error types).
- [ ] Generation is wired into CI to catch doc-comment regressions (a method missing documentation) going forward.
- [ ] Output location and publishing (GitHub Pages, or just build-and-check for now) is decided explicitly.

## Files

- packages/sdk-ts/typedoc.json
- .github/workflows/ci.yml
