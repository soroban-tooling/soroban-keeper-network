---
title: "docs(ci): document which CI checks block a merge and which are advisory"
labels: [docs, tooling, good-first-issue]
epic: E21
wave: 1
depends_on: []
---

## Summary

The CI pipeline deliberately splits checks into blocking and advisory, but nothing explains the split to a contributor. Someone seeing a red X next to "Clippy (advisory)" has no way to know their PR is still mergeable.

## Current state

`.github/workflows/ci.yml` marks several jobs `continue-on-error: true`, and branch protection is expected to require only the aggregate `CI required checks` job. That design is sound, but the only record of it is comments inside the workflow file — which contributors do not read.

The GitHub PR checks UI makes this worse rather than better. An advisory job that finds something shows as failed in the checks list, visually identical to a genuine failure. The job name carries "(advisory)", which helps, but nothing tells a first-time contributor that the word means their PR is fine.

`.github/workflows/pr-hygiene.yml` compounds it: every job there is advisory and several deliberately emit warning annotations for things like PR title format and diff size. A contributor can easily see three or four warning markers on a perfectly acceptable PR.

## Why this matters for a wave program

Contributors arriving through a wave program are often opening their first PR to this codebase and sometimes their first PR anywhere. The failure mode is not that they merge something broken — branch protection prevents that. It is that they see red, assume they broke something, and either churn on unrelated lint findings or abandon the PR.

A page explaining "these three checks must be green, everything else is information" converts that anxiety into a five-second read.

## Expected behaviour

`docs/CI.md` documents every job, its blocking status, what it checks, how to run it locally, and what to do when it fails.

## Suggested approach

Write it for the contributor, not the maintainer. Lead with the summary table, because that is the question people arrive with:

```markdown
| Check | Blocks merge? | Run locally |
|-------|---------------|-------------|
| Format | Yes | `cargo fmt --all` |
| Tests | Yes | `cargo test --workspace` |
| Build WASM | Yes | `make wasm` |
| Clippy | No — advisory | `cargo clippy --workspace --all-targets` |
| Dependency audit | No — advisory | `cargo audit` |
| WASM size report | No — informational | `make optimize` |
| Keeper bot | No — advisory | `cd examples/keeper-bot && npm run lint` |
| PR title / size / diff guard | No — advisory | — |
```

Then a short section per job: what it looks for, why it exists, and the concrete fix for the common failure. The formatting job is the highest-traffic one — everybody hits it once — so give it the clearest instructions.

Cover two things a contributor will otherwise get wrong:

**Why advisory checks exist at all.** Explain that a new upstream CVE should not break every open PR, and that clippy lints are a review input rather than a merge gate. Without the reasoning, "advisory" reads as "we did not finish setting this up".

**Where the real gate is.** Branch protection requires the single `CI required checks` job, which aggregates the three blocking jobs. Say so, so contributors know which one to watch.

Add a section on the Windows line-ending trap: `.gitattributes` pins LF, and a contributor whose git predates it or who has `core.autocrlf=true` on an older clone can see `cargo fmt` fail locally while CI is green. The fix is `git config core.autocrlf false` and a fresh checkout. This costs someone an hour if it is not written down.

Link the page from CONTRIBUTING and from the CI badge area of README.

## Acceptance criteria

- [ ] `docs/CI.md` exists with a summary table of every job and its blocking status.
- [ ] Each job has a section covering purpose, local reproduction, and common fixes.
- [ ] The rationale for the blocking/advisory split is stated.
- [ ] The aggregate required check is identified by name.
- [ ] The Windows line-ending pitfall is documented with its fix.
- [ ] CONTRIBUTING and README link to the page.
- [ ] Job names in the document match `ci.yml` exactly.

## Files

- `docs/CI.md` — new
- `CONTRIBUTING.md`
- `README.md`
