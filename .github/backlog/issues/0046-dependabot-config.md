---
title: "chore(ci): add Dependabot configuration for cargo, npm, and GitHub Actions"
labels: [tooling, security, good-first-issue]
epic: E21
wave: 1
depends_on: []
---

## Summary

Nothing tracks dependency updates. The Rust crates, the keeper bot's npm packages, and the pinned GitHub Actions all drift until someone notices manually.

## Current state

Three dependency surfaces, none automated:

- `Cargo.toml` pins `soroban-sdk = "22.0.1"`.
- `examples/keeper-bot/package.json` pins `@stellar/stellar-sdk ^13.0.0`, `dotenv ^16.4.5`, `eslint ^9.0.0`.
- The workflows pin `actions/checkout@v4`, `actions/cache@v4`, `actions/upload-artifact@v4`, `actions/setup-node@v4`, `dtolnay/rust-toolchain@stable`.

CI runs `cargo audit` as an advisory job, so a known vulnerability in a Rust crate will at least be reported. But `cargo audit` only reports — it opens no PR, and it covers only the Cargo tree. Nothing looks at npm or Actions at all.

The Actions gap is the one most often overlooked. A compromised or abandoned action runs with access to the workflow token, and major-version tags like `@v4` are mutable — they move as the action publishes updates. Dependabot at least surfaces when those tags move to a new major.

## Expected behaviour

Dependabot opens grouped, scheduled PRs for all three ecosystems.

## Suggested approach

`.github/dependabot.yml`:

```yaml
version: 2
updates:
  - package-ecosystem: cargo
    directory: "/"
    schedule:
      interval: weekly
      day: monday
    open-pull-requests-limit: 5
    # Patch and minor bumps arrive as one PR so a quiet week produces one
    # review, not six. Majors stay separate — they need real attention.
    groups:
      cargo-minor-patch:
        update-types: [minor, patch]
    commit-message:
      prefix: "chore(deps)"

  - package-ecosystem: npm
    directory: "/examples/keeper-bot"
    schedule:
      interval: weekly
      day: monday
    open-pull-requests-limit: 5
    groups:
      npm-minor-patch:
        update-types: [minor, patch]
    commit-message:
      prefix: "chore(deps)"

  - package-ecosystem: github-actions
    directory: "/"
    schedule:
      interval: monthly
    commit-message:
      prefix: "chore(ci)"
```

Three details worth getting right:

**Commit prefixes must match the convention.** The PR-title check expects Conventional Commits, and Dependabot's default prefix does not comply. Setting `commit-message.prefix` makes its PRs pass the same check everyone else's do.

**Group aggressively.** Ungrouped Dependabot on three ecosystems produces enough noise that people stop reading it, which is worse than not having it. Weekly grouped minor/patch updates and separate major PRs is a reasonable starting point.

**`soroban-sdk` majors are not routine.** An SDK major can change contract ABI or storage semantics. Consider ignoring major updates for it entirely and handling them as deliberate migration work with their own issue, rather than letting a bot open a PR that looks like every other dependency bump. If you do, comment the reason in the config.

Also confirm Dependabot can see `examples/keeper-bot` — it has a `package.json` but no committed `package-lock.json`, so updates will be resolved from the manifest ranges. Check whether the lockfile should be committed; for an example whose whole purpose is being reproducible, it probably should. Note the finding on the issue if you think so, rather than committing it as a surprise in this PR.

## Acceptance criteria

- [ ] `.github/dependabot.yml` covers cargo, npm, and github-actions.
- [ ] Commit message prefixes satisfy the Conventional Commits PR title check.
- [ ] Minor and patch updates are grouped; majors are separate.
- [ ] PR limits are set so a quiet week does not flood the queue.
- [ ] The `soroban-sdk` major-version policy is decided and commented.
- [ ] The keeper-bot lockfile question is raised, with a recommendation.
- [ ] CONTRIBUTING notes that dependency PRs are reviewed like any other.

## Files

- `.github/dependabot.yml` — new
- `CONTRIBUTING.md`
