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
git clone https://github.com/arandomogg/soroban-keeper-network
cd soroban-keeper-network

# Verify Rust and WASM target
rustup show
rustup target list --installed | grep wasm32

# Install JS dependencies for the keeper bot example
cd examples/keeper-bot && npm install && cd ../..

# Run tests (should all pass on a clean checkout)
cargo test --all --features testutils

# Build WASM
cargo build --release --target wasm32-unknown-unknown --package keeper-registry

# Check formatting and lints (must be clean before PR)
cargo fmt --all -- --check
cargo clippy --all --all-targets --all-features -- -D warnings
```

---

## Project Structure

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
├── .github/
│   └── workflows/
│       └── ci.yml                # GitHub Actions CI
├── README.md                     # Full PRD + docs
├── CONTRIBUTING.md               # This file
├── CODE_OF_CONDUCT.md
├── SECURITY.md
└── LICENSE
```

---

## Git Workflow

We use a **trunk-based development** model with protected long-lived branches:

```
main ──────────────────────────────────────────────────────── (always stable, released)
  └── develop ────────────────────────────────────────────── (integration branch)
        ├── feature/add-verifier-interface
        ├── fix/reclaim-lock-ledger-check
        └── chore/update-soroban-sdk-22
```

### Branch Purposes

| Branch | Purpose | Direct push? |
|--------|---------|-------------|
| `main` | Latest stable release, tagged versions | **Never** |
| `develop` | Integration of completed features before release | **Never** |
| `feature/*` | New features | Your own branch — yes |
| `fix/*` | Bug fixes | Your own branch — yes |
| `chore/*` | Dependency updates, tooling, CI | Your own branch — yes |
| `docs/*` | Documentation only changes | Your own branch — yes |
| `refactor/*` | Code restructuring (no behaviour change) | Your own branch — yes |

> **CRITICAL**: Never push directly to `main` or `develop`. All changes go through PRs with at least one review. This rule is enforced via branch protection rules.

---

## Branching & PR Rules

### Before Starting Work

1. **Check Issues** — is this already being worked on? Comment on the issue to signal intent.
2. **Open an issue** — if one doesn't exist, open it and get feedback before writing code.
3. **Branch from `develop`**, not `main`:

```bash
git checkout develop
git pull origin develop
git checkout -b feature/your-feature-name
```

### PR Requirements Checklist

Before opening a PR:

- [ ] Branch is based on `develop` (not `main`)
- [ ] `cargo fmt --all` passes (no formatting diff)
- [ ] `cargo clippy --all --all-targets --all-features -- -D warnings` passes
- [ ] All existing tests pass: `cargo test --all --features testutils`
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
- **Linting**: ESLint with the config in `examples/keeper-bot/.eslintrc.json`.

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

---

## PR Template & Review Process

When you open a PR, GitHub will populate this template automatically (save it at `.github/PULL_REQUEST_TEMPLATE.md`):

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
- [ ] PR targets `develop`, not `main`

## Related Issues

Closes #<!-- issue number -->
```

### Review Process

1. Open PR against `develop`.
2. CI must be green before review is requested.
3. Request review from at least one maintainer (tag `@arandomogg` for now).
4. Address all review comments. Mark conversations resolved after addressing.
5. Maintainer squash-merges the PR with a conventional commit message.
6. Delete the feature branch after merge.

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

1. **Feature freeze** — all features targeting the release are merged to `develop`.
2. **Release branch** — create `release/vX.Y.Z` from `develop`.
3. **Final testing** — run full test suite + testnet deployment on release branch.
4. **Changelog** — update `CHANGELOG.md` (use Conventional Commits history as source).
5. **Version bump** — update `version` in all `Cargo.toml` files.
6. **PR to `main`** — merge `release/vX.Y.Z` → `main` via PR (requires 2 maintainer approvals).
7. **Tag** — `git tag -s vX.Y.Z -m "Release vX.Y.Z"` + `git push origin vX.Y.Z`.
8. **GitHub Release** — create release with changelog notes and attach optimized WASM artifact.
9. **Back-merge** — merge `main` → `develop` to sync the version bump.

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
