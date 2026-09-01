# Contributing to Soroban Keeper Network

Thank you for your interest in contributing! This guide covers everything you need to know to submit quality contributions and avoid common pitfalls that cause PR conflicts or delays.

**Please read this entire document before opening a PR or issue.**

---

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Development Environment Setup](#development-environment-setup)
- [Project Structure](#project-structure)
- [Git Workflow](#git-workflow)
- [Branching & PR Rules](#branching--pr-rules)
- [Commit Convention](#commit-convention)
- [Code Style](#code-style)
- [Testing Requirements](#testing-requirements)
- [PR Template & Review Process](#pr-template--review-process)
- [Coordination — Issues & Discussions](#coordination--issues--discussions)
- [Release Process](#release-process)
- [Security Reporting](#security-reporting)

---

## Code of Conduct

This project follows the [Contributor Covenant v2.1](CODE_OF_CONDUCT.md). By participating you agree to uphold a respectful, harassment-free environment. Report violations to **conduct@soroban-keeper.network** (email TBD once domain is registered).

---

## Development Environment Setup

### Required Tools

| Tool | Version | Install |
|------|---------|---------|
| Rust | stable (≥ 1.78) | `rustup install stable` |
| wasm32 target | — | `rustup target add wasm32-unknown-unknown` |
| Soroban CLI | ≥ 22.x | `cargo install --locked stellar-cli --features opt` |
| Node.js | ≥ 18 LTS | [nodejs.org](https://nodejs.org) |
| npm | ≥ 9 | bundled with Node.js |
| git | ≥ 2.40 | system package manager |

### Optional (Recommended)

| Tool | Purpose |
|------|---------|
| `wasm-opt` | WASM size optimization: `cargo install wasm-opt --locked` |
| `cargo-audit` | Security advisory scan: `cargo install cargo-audit --locked` |
| `cargo-expand` | Inspect macro expansions |
| VS Code + `rust-analyzer` | IDE support |
| VS Code + `stellar-sdk` extension | Soroban intellisense |

### VS Code Recommended Extensions

Add to `.vscode/extensions.json` (not committed to avoid forcing preferences):

```json
{
  "recommendations": [
    "rust-lang.rust-analyzer",
    "tamasfe.even-better-toml",
    "serayuzgur.crates",
    "streetsidesoftware.code-spell-checker"
  ]
}
```

### First-Time Setup

```bash
# Clone
git clone https://github.com/soroban-tooling/soroban-keeper-network
cd soroban-keeper-network

# Verify Rust and WASM target
rustup show
rustup target list --installed | grep wasm32

# Install JS dependencies for the keeper bot example
cd examples/keeper-bot && npm install && cd ../..

# Run tests (should all pass on a clean checkout)
cargo test --workspace --locked

# Build WASM
cargo build --locked --release --target wasm32-unknown-unknown --package keeper-registry

# Run all required CI checks locally
make ci

# Optionally run stricter checks (includes clippy)
make check
```

We use **trunk-based development**. The `main` branch is the trunk, and it must always be stable and releasable.

All work happens on short-lived branches prefixed with `feature/`, `fix/`, etc.

```
soroban-keeper-network/
├── Cargo.toml                    # Workspace root
├── contracts/
│   └── keeper-registry/
│       ├── Cargo.toml
│       └── src/
│           ├── lib.rs            # Contract implementation
│           └── test.rs           # Unit + integration tests
├── tests/                        # Additional integration test files
├── scripts/
│   └── deploy.sh                 # Deployment script
├── examples/
│   └── keeper-bot/               # Off-chain keeper bot (Node.js)
├── packages/
│   └── sdk-ts/                   # TypeScript SDK for the contract (npm package)
├── .github/
│   └── workflows/
│       └── ci.yml                # GitHub Actions CI
├── README.md                     # Full PRD + docs
├── CONTRIBUTING.md               # This file
├── CODE_OF_CONDUCT.md
├── SECURITY.md
└── LICENSE
```

| Branch | Purpose | Direct push? |
|--------|---------|-------------|
| `main` | The single source of truth. Always stable. | **Never** |
| `feature/*` | New features | Your own branch — yes |
| `fix/*` | Bug fixes | Your own branch — yes |
| `chore/*` | Dependency updates, tooling, CI | Your own branch — yes |
| `docs/*` | Documentation only changes | Your own branch — yes |
| `refactor/*` | Code restructuring (no behaviour change) | Your own branch — yes |

---

## Project Structure

The contract and its tests are split into small, single-purpose modules. This
is deliberate: it keeps two contributors working on different areas out of each
other's way, because their changes land in different files instead of colliding
at the end of one large one.

```
contracts/keeper-registry/src/
├── lib.rs         module wiring, the contract struct, re-exports
├── errors.rs      KeeperError
├── types.rs       DataKey, Task, TaskType, TaskStatus, BatchTaskParams
├── constants.rs   every tunable bound and protocol constant
├── events.rs      the emit_* helpers
├── internal.rs    shared pub(crate) helpers and guards
├── task.rs        register / claim / execute / cancel / expire / withdraw
├── batch.rs       batch_register_tasks, get_tasks, get_tasks_range
├── admin.rs       initialize, pause, fees, transfer_admin, upgrade, sweep
├── views.rs       read-only getters
├── invariants.rs  shared invariant assertions (tests and fuzz targets)
└── test/          one module per area, mirroring the list above
```

**Where does my change go?**

| You are… | Edit |
|----------|------|
| changing a task lifecycle rule | `task.rs` + `test/<area>.rs` |
| adding or changing an admin control | `admin.rs` + `test/admin.rs` |
| adding a read-only view | `views.rs` + `test/…` |
| adding an error variant | `errors.rs` — take the next free discriminant, never renumber |
| changing a bound or magic number | `constants.rs` — it should exist in exactly one place |
| adding an event | `events.rs`, and update the README event table |
| adding a helper used by more than one entry point | `internal.rs` as `pub(crate)` |
| adding a test fixture used by more than one test module | `test/common.rs` as `pub(crate)` |

Two conventions worth following, both learned the hard way:

- **Never inline a value that is enforced in more than one place.** Give it a
  name in `constants.rs`. A literal repeated across call sites means a rule
  change touches every one of them, which is how one small edit ends up
  conflicting with every open PR.
- **Name test helper modules after their scope** (`reentrant_token_cancel`,
  not `reentrant_token`). Two PRs that each add a generically named helper
  module will compile alone and fail once both land.

---

## Where Contributors Come In

The MVP contract is functional and stable. The open work now focuses on three
published epics spanning 100 issues (0051–0150):

- **E03 Fuzzing & Invariant Testing** (20 issues) — property-based tests,
  stateful model checking, and mutation testing to systematically verify the
  money-movement invariants documented in `docs/ARCHITECTURE.md`.
- **E04 On-chain Execution Verifier** (26 issues) — the `IKeeperVerifier`
  interface and registry-side verification callback, allowing target protocols
  to enforce that a keeper actually performed the promised work on-chain before
  the registry credits the reward.
- **E05 Batch Operations & Gas** (22 issues) — batch registration (already
  shipped), storage layout tuning, WASM size optimization, and CPU budget work.

Each epic closes with a retrospective documenting what shipped versus what was
studied and deferred. See the **epic index** in `.github/backlog/README.md`
for the full roadmap, including wave 3 (TypeScript SDK, Rust SDK, event
indexer, keeper bot v2) and beyond.

**Picking an issue:**

1. Browse `.github/backlog/issues/` or filter by label on GitHub Issues.
2. Look for the `good-first-issue` label if this is your first contribution.
3. Comment on the issue to claim it before starting work.
4. Follow the [Git Workflow](#git-workflow) and [PR Requirements](#branching--pr-rules) below.

## Git Workflow

We use **trunk-based development**. The `main` branch is the trunk, and it must always be stable and releasable.

All work happens on short-lived branches prefixed with `feature/`, `fix/`, etc.

```
main ────────────────────────────────────────────────── (always stable, releasable)
  ├── feature/add-verifier-interface
  ├── fix/reclaim-lock-ledger-check
  └── chore/update-soroban-sdk-22
```

### Branch Purposes

| Branch | Purpose | Direct push? |
|--------|---------|-------------|
| `main` | The single source of truth. Always stable. | **Never** |
| `feature/*` | New features | Your own branch — yes |
| `fix/*` | Bug fixes | Your own branch — yes |
| `chore/*` | Dependency updates, tooling, CI | Your own branch — yes |
| `docs/*` | Documentation only changes | Your own branch — yes |
| `refactor/*` | Code restructuring (no behaviour change) | Your own branch — yes |

### Branch Protection

The `main` branch is protected by the following rules:

- **Requires a Pull Request**: All changes must be made through a PR.
- **Requires Status Checks to Pass**: CI jobs (build, test, lint) must pass before merging.
- **Requires Review**: At least one maintainer must approve the PR.
- **No Force Pushing**: History cannot be rewritten.

> **CRITICAL**: Never push directly to `main`. All changes go through PRs with at least one review. This rule is enforced via branch protection rules.

---

## Branching & PR Rules

### Before Starting Work

1. **Check Issues** — is this already being worked on? Comment on the issue to signal intent.
2. **Open an issue** — if one doesn't exist, open it and get feedback before writing code.
3. **Branch from `main`**:

```bash
git checkout main
git pull origin main
git checkout -b feature/your-feature-name
```

### PR Requirements Checklist

Before opening a PR:

- [ ] Branch is based on `main`
- [ ] `make ci` passes (format check, tests, WASM build)
- [ ] `make check` passes (ci + clippy) — or explain why clippy warnings are acceptable
- [ ] New code has corresponding test coverage
- [ ] No `TODO`, `FIXME`, or `unwrap()` added without a comment explaining why
- [ ] No sensitive data (keys, credentials) in any file
- [ ] PR description fills out the template below

### PR Title Format

```
<type>(<scope>): <short description>

Examples:
feat(registry): add batch task registration
fix(claim): allow re-claim after lock period expires
docs(readme): add integration guide section
chore(deps): upgrade soroban-sdk to 22.1.0
test(expire): add missing deadline boundary test
```

Use the same types as [Conventional Commits](#commit-convention).

### PR Size

- Keep PRs focused. One logical change per PR.
- PRs with > 500 lines changed should include a justification in the description.
- Refactors and feature work should be in separate PRs.

---

## Commit Convention

We follow **[Conventional Commits v1.0.0](https://www.conventionalcommits.org/en/v1.0.0/)**.

### Format

```
<type>(<optional scope>): <description>

[optional body]

[optional footer: BREAKING CHANGE: ..., Closes #N]
```

### Types

| Type | When to use |
|------|------------|
| `feat` | A new feature |
| `fix` | A bug fix |
| `docs` | Documentation only |
| `style` | Formatting, missing semicolons — no logic change |
| `refactor` | Code change that neither fixes a bug nor adds a feature |
| `test` | Adding or correcting tests |
| `chore` | Build, CI, dependency updates |
| `perf` | Performance improvement |
| `security` | Security fix (ping maintainers before pushing) |

### Examples

```
feat(registry): add sweep_fees admin function

Allows admin to transfer accumulated protocol fees to a treasury
address. Phase 2 will automate this via a governance contract.

Closes #42

fix(claim): reject re-claim when lock period still active

Previously the lock check used timestamp instead of ledger sequence,
causing incorrect lock expiry on networks with variable block times.

BREAKING CHANGE: lock_ledgers is now compared against ledger sequence
not unix timestamp. Existing tasks with in-flight claims are unaffected.
```

---

## Code Style

### Rust

- **Formatter**: `rustfmt` with default settings. Run `cargo fmt --all` before committing.
- **Linter**: `cargo clippy --all --all-targets --all-features -- -D warnings`. All warnings are errors.
- **Naming**: follow Rust conventions — `snake_case` for functions/variables, `PascalCase` for types/enums.
- **Error handling**: use `Result<T, KeeperError>` — no panics in contract code except truly unreachable states (document these with `// SAFETY:` comments).
- **No `unwrap()` in contract code** — use `ok_or(KeeperError::Foo)?` or `expect("message that explains why this is unreachable")`.
- **Comments**: explain _why_, not _what_. The code explains what; comments explain intent, invariants, and non-obvious behaviour.
- **Doc comments**: use `///` for all public items (functions, structs, enums, variants).

### JavaScript / Node.js (keeper bot)

- **Style**: ES2022+, `"use strict"`, CommonJS (`require`).
- **No TypeScript** in the example (to keep it beginner-friendly). A TypeScript version is welcome as a separate example.
- **Linting**: ESLint with the config in `examples/keeper-bot/eslint.config.js`.

---

## Testing Requirements

### Coverage Expectations

- Every new public contract function MUST have at least:
  - One happy-path test
  - Tests for each error case (`KeeperError` variant the function can return)
- Bug fixes MUST include a regression test that fails before the fix and passes after.
- PRs that remove tests must justify why in the PR description.

### Running Tests

```bash
# All tests (unit + integration)
cargo test --all --features testutils

# One specific test
cargo test --features testutils test_full_lifecycle_multiple_tasks -- --nocapture

# Watch mode (requires cargo-watch)
cargo watch -x "test --all --features testutils"
```

### Test Structure

- Unit tests live in `contracts/keeper-registry/src/test.rs`.
- Integration tests that cross contract boundaries go in `tests/`.
- Use `Env::default()` + `env.mock_all_auths()` for simplicity in unit tests.
- Use real auth flows when testing auth-specific paths.

### Fuzzing & crash-to-regression convention

A crash found by the fuzz harness (`fuzz/fuzz_targets/`) and merely "fixed"
is a bug that can silently come back — a future refactor can reintroduce
the same shape of mistake, and the fuzzer might not rediscover it for a
long time since it searches randomly rather than systematically. **Every
crash the fuzzer finds must become a permanent, checked-in regression**,
not just a patched line of contract code:

1. Minimize the crashing input (`cargo fuzz tmin <target> <path-to-crash>`)
   and commit it under `fuzz/corpus/<target>/regressions/`, so the fuzzer's
   own corpus keeps re-testing it on every future run.
2. Add a corresponding `#[test]` in `contracts/keeper-registry/src/test.rs`
   that reproduces the exact scenario **in human-readable form** — the
   actual sequence of contract calls that triggered the crash, not "replay
   these fuzzer bytes." A raw fuzzer input replay is not reviewable by a
   human and doesn't explain *why* the input was dangerous.
3. If the crash revealed a gap in one of the money invariants (`I-1`
   through `I-7` in `docs/ARCHITECTURE.md`), consider whether it should
   also become a case in the corresponding property test rather than only
   a one-off regression.

Any PR that fixes a bug found by fuzzing must include both the minimized
corpus entry and the human-readable regression test in the same commit as
the fix — see the PR template's checkbox for this.

See [`docs/FUZZING.md`](docs/FUZZING.md) for how to run an existing fuzz
target, add a new one, and use the shared `invariants` module.

**"How do I know if my change broke an invariant?"** Start with
[`docs/FUZZING.md`'s "Epic E03 retrospective: invariant coverage
map"](docs/FUZZING.md#epic-e03-retrospective-invariant-coverage-map) — it
lists every numbered invariant alongside the property test and/or fuzz
target that actually exercises it, so you can find (or add to) the
relevant coverage instead of re-deriving it from scratch.

---

## PR Template & Review Process

When you open a PR, GitHub will populate this template automatically from `.github/PULL_REQUEST_TEMPLATE.md`.

### Example Template
```markdown
## Summary

<!-- One paragraph explaining what this PR does and why -->

## Changes

- [ ] <!-- Change 1 -->
- [ ] <!-- Change 2 -->

## Testing

<!-- Describe how you tested this. New tests added? Manual testnet verification? -->

## Checklist

- [ ] `cargo fmt --all` passes
- [ ] `cargo clippy` passes (no warnings)
- [ ] All tests pass
- [ ] New tests added for new code
- [ ] No `unwrap()` without explanation
- [ ] No sensitive data in code or commits
- [ ] PR targets `main`

## Related Issues

Closes #<!-- issue number -->
```

### Review Process

1. Open PR against `main`.
2. CI must be green before review is requested.
3. Request review from at least one maintainer (tag `@Andreschuks101` for now).
4. Address all review comments. Mark conversations resolved after addressing.
5. Maintainer squash-merges the PR with a conventional commit message.
6. Delete the feature branch after merge.

**Note on Dependabot PRs**: Automated dependency update PRs from Dependabot follow the same review process as all other pull requests. Maintainers will review the changelog, check for breaking changes, and verify CI passes before merging.

### Review Turnaround

Maintainers aim to respond within **48 hours** on weekdays. Complex PRs may take longer — please be patient.

---

## Coordination — Issues & Discussions

### GitHub Issues

- Use Issues to track bugs, feature requests, and tasks.
- Label your issue: `bug`, `enhancement`, `question`, `documentation`, `security`, `good first issue`.
- For bugs: include steps to reproduce, expected vs actual behaviour, Rust version, OS.
- For features: link to the relevant PRD section or user story if applicable.

### GitHub Discussions

- Use Discussions for open-ended questions, design proposals, and community announcements.
- Major design changes (new storage layout, breaking API changes) MUST go through a Discussion before implementation begins to get early feedback.

### Discord

> Discord server coming soon — link will be added here once the community grows to > 20 contributors.

---

## Release Process

1. **Agree on a release version** — maintainers decide on the next `vX.Y.Z` number.
2. **Create a release branch** — `git checkout -b release/vX.Y.Z main`.
3. **Final testing** — run the full test suite and deploy to testnet from the release branch.
4. **Update `CHANGELOG.md`** — use the commit history to add notable changes.
5. **Bump versions** — update the `version` in all relevant `Cargo.toml` files.
6. **Open a PR** — merge the release branch into `main`. This PR requires at least two maintainer approvals.
7. **Tag the release** — after merging, pull the latest `main`, then run `git tag -s vX.Y.Z -m "Release vX.Y.Z"` and `git push origin vX.Y.Z`.
8. **Create a GitHub Release** — go to the tags page, create a new release from the tag, and paste the changelog notes. Attach the optimized WASM file.

### Versioning

We follow **Semantic Versioning 2.0.0**:
- `MAJOR` — breaking changes to the on-chain interface or storage layout
- `MINOR` — new backwards-compatible functionality
- `PATCH` — backwards-compatible bug fixes

---

## Security Reporting

**Do not open a public issue for security vulnerabilities.**

Please follow the responsible disclosure process described in [SECURITY.md](SECURITY.md). We aim to acknowledge reports within 24 hours and issue patches within 7 days for critical issues.

---

*Thank you for helping build the automation layer for Stellar DeFi.*
