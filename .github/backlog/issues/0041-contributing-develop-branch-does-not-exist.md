---
title: "docs(contributing): the required develop branch does not exist, so the documented workflow cannot be followed"
labels: [docs, bug, tooling, good-first-issue]
epic: E21
wave: 1
depends_on: []
---

## Summary

CONTRIBUTING instructs every contributor to branch from `develop` and open PRs against `develop`. The repository has only `main`. The first commands a new contributor runs will fail.

## Current state

CONTRIBUTING, under Branching & PR Rules:

```bash
git checkout develop
git pull origin develop
git checkout -b feature/your-feature-name
```

`git branch -r` on a fresh clone returns:

```
origin/HEAD -> origin/main
origin/main
```

So `git checkout develop` fails immediately with `pathspec 'develop' did not match any file(s) known to git`. That is the third command in the contributor onboarding path, and it fails for everyone.

The requirement is repeated in three more places:

- The Git Workflow diagram shows `main` and `develop` as protected long-lived branches.
- The branch table lists `develop` as "integration of completed features before release", never directly pushed.
- The PR checklist has "Branch is based on `develop` (not `main`)", and the review process says "Open PR against `develop`".
- The release process describes cutting `release/vX.Y.Z` from `develop` and back-merging `main` into `develop`.

Meanwhile `.github/workflows/ci.yml` triggers on pull requests without a branch restriction, so CI would run either way — nothing enforces the documented model, and nothing reveals that it is unbuildable.

## Why this needs a decision, not just a fix

There are two coherent resolutions and they lead to different projects.

**Create `develop`.** Matches what the documentation already describes. Appropriate if the project genuinely wants an integration branch that accumulates features between releases. The cost is real: every contributor must target the right branch, maintainers must keep `main` and `develop` in sync, back-merges after each release are a recurring chore, and PRs opened against the wrong branch become a routine review comment.

**Drop `develop` and standardise on `main`.** Contributors branch from `main` and PR into `main`, which is protected and always releasable. Releases are cut as tags from `main`. This is what the repository actually does today, it matches the trunk-based model CONTRIBUTING claims to follow in its own opening line — "We use a **trunk-based development** model" — and it removes an entire class of contributor mistake.

Note the internal contradiction: CONTRIBUTING describes itself as trunk-based and then documents GitFlow. Those are different things. A two-branch integration model is not trunk-based development.

**Recommendation: drop `develop`.** For a project of this size, with contributors arriving through a wave program and opening their first PR, the integration branch is overhead with no corresponding benefit. Releases are already tag-driven — `.github/workflows/release.yml` triggers on `v*.*.*` tags from any branch — so nothing in the automation needs `develop` to exist.

Whoever picks this up should state the choice on the issue and get agreement before editing, because the answer changes several documents.

## Expected behaviour

The documented workflow can be followed literally on a fresh clone, and every document agrees on which branch PRs target.

## Suggested approach

If standardising on `main`:

- Rewrite the Git Workflow section, the branch table, and the diagram.
- Fix the PR checklist item, the review process step, and the release process.
- Keep the `feature/`, `fix/`, `chore/`, `docs/`, `refactor/` prefix convention — it is useful and independent of this question.
- Check `.github/PULL_REQUEST_TEMPLATE.md`, the issue templates, and `README.md` for the same assumption.
- State the branch protection rules that should be applied to `main`, so the documentation matches the repository settings.

If creating `develop`: create it from `main`, set it as the default branch for PRs, add it to the CI trigger list, and document the back-merge step as part of the release checklist.

## Acceptance criteria

- [ ] The chosen model is agreed on the issue before any edit.
- [ ] A contributor can run the documented setup commands on a fresh clone without error.
- [ ] Every reference to a branching model across CONTRIBUTING, README, PR template, and issue templates agrees.
- [ ] The "trunk-based" description matches the model actually documented.
- [ ] The release process is consistent with the chosen model.
- [ ] Required branch protection settings are written down.

## Files

- `CONTRIBUTING.md`
- `README.md`
- `.github/PULL_REQUEST_TEMPLATE.md`
- `.github/ISSUE_TEMPLATE/*.yml`

## Getting started

Good first issue for someone who would rather write than code — and it is the single highest-impact documentation fix available, because it blocks every other contributor at step three.
