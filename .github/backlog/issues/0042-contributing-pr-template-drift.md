---
title: "docs(contributing): the PR template is duplicated inline and the two copies already disagree"
labels: [docs, good-first-issue]
epic: E21
wave: 1
depends_on: []
---

## Summary

CONTRIBUTING embeds a full copy of the pull request template in a fenced code block, alongside the real one at `.github/PULL_REQUEST_TEMPLATE.md`. The two have already drifted apart.

## The two copies

CONTRIBUTING says:

> When you open a PR, GitHub will populate this template automatically (save it at `.github/PULL_REQUEST_TEMPLATE.md`):

followed by a code block containing a checklist:

```
- [ ] `cargo fmt --all` passes
- [ ] `cargo clippy` passes (no warnings)
- [ ] All tests pass
- [ ] New tests added for new code
- [ ] No `unwrap()` without explanation
- [ ] No sensitive data in code or commits
- [ ] PR targets `develop`, not `main`
```

The actual `.github/PULL_REQUEST_TEMPLATE.md` has:

```
- [ ] `cargo test -p keeper-registry` passes
- [ ] `cargo fmt --all -- --check` is clean
- [ ] `cargo clippy --all-targets -- -D warnings` is clean
- [ ] Added/updated tests for the change
- [ ] Updated docs / CHANGELOG where relevant
- [ ] The PR is scoped to a single concern
```

Different items, different wording, different commands. The real template also has a "Type of change" section the copy lacks, and the copy has a `## Related Issues` section the real one folds into the summary.

The instruction "save it at `.github/PULL_REQUEST_TEMPLATE.md`" is also addressed to the wrong person. It reads as though the contributor should create the file. The file exists; contributors do not need to do anything.

## Why this is worth fixing

A contributor reading CONTRIBUTING end to end, as its own opening line instructs — "Please read this entire document before opening a PR" — will believe the checklist includes "PR targets `develop`, not `main`". Then GitHub shows them a different checklist that says nothing about branches. The contradiction undermines confidence in the rest of the document.

It also guarantees future drift. Two copies of anything diverge, and this pair already has. Whichever copy a maintainer updates, the other becomes wrong.

## Expected behaviour

The template exists in exactly one place. CONTRIBUTING links to it and explains the review process without restating its contents.

## Suggested approach

Replace the inline block with a short pointer:

```markdown
## PR Template & Review Process

Opening a pull request populates
[`.github/PULL_REQUEST_TEMPLATE.md`](.github/PULL_REQUEST_TEMPLATE.md)
automatically. Fill in every section — the checklist items correspond to
checks that run in CI, so working through them before pushing is the fastest
route to a green build.
```

Keep the "Review Process" and "Review Turnaround" subsections, which describe things the template does not cover and are genuinely useful.

Then reconcile the two checklists into one good list in the real template. Two things to resolve while doing so:

- The branch-targeting item depends on the outcome of the `develop` branch issue. Coordinate, or leave it out and let that issue add it back.
- The template requires `cargo clippy -- -D warnings` to be clean, but the CI pipeline treats clippy as advisory. A checklist item stricter than CI is a checklist item people learn to tick without reading. Soften it to match, or say explicitly that it is a stronger local standard than CI enforces.

The same duplication risk exists elsewhere in CONTRIBUTING — the VS Code `extensions.json` block is presented the same way. Worth a look while you are in there.

## Acceptance criteria

- [ ] The inline PR template block is removed from CONTRIBUTING and replaced by a link.
- [ ] `.github/PULL_REQUEST_TEMPLATE.md` contains the single reconciled checklist.
- [ ] The misleading "save it at ..." instruction is gone.
- [ ] The clippy checklist item matches actual CI policy, or explicitly states it is stricter.
- [ ] No other section of CONTRIBUTING duplicates a file that exists in the repository.

## Files

- `CONTRIBUTING.md`
- `.github/PULL_REQUEST_TEMPLATE.md`

## Getting started

Good first issue — documentation only, no build required.
