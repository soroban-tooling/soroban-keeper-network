# Changelog

All notable changes to the Soroban Keeper Network are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added — contract capabilities & views

- `increase_reward` — owners can top up a task bounty (Pending/Claimed).
- `extend_deadline` — owners can push out a task's deadline.
- `set_min_reward` + `min_reward` view — admin-set anti-dust floor for new tasks.
- `is_claimable` view — cheap keeper-side eligibility check.
- `version` view + `VERSION` constant for ABI detection.
- Governance events on pause/unpause, fee change, and admin transfer, plus
  `topup`/`extend` task events.

### Added — tests

- `split_reward` accounting-invariant sweep (conservation, bounds, formula).
- Multi-keeper end-to-end conservation test across execute/expire/cancel.
- Test count grown from 38 to 52.

### Added — contributor infrastructure

- CONTRIBUTING-facing repo setup: `.editorconfig`, `rustfmt.toml`, `.gitignore`,
  Code of Conduct, issue templates (bug / feature / good-first-issue) + chooser,
  PR template, `CODEOWNERS`, a Wave-Program label taxonomy, and a `Makefile`.
- `docs/ARCHITECTURE.md` and `docs/DEPLOYING.md`; README documentation index.
- `scripts/optimize.sh` build/optimize helper.

### Changed

- CI: concurrency control (cancels superseded runs) and `--locked` builds.
- Repository references updated to the `soroban-tooling` org.

### Fixed

- Cleared all compiler and `clippy -D warnings` findings and applied `rustfmt`
  so the CI lint/format gates pass. Removed the ignored child-manifest
  `[profile.release]`.

### Added — MVP contract feature-complete

The `KeeperRegistry` contract's core lifecycle is now fully implemented and
tested (38 unit tests, full happy-path and error-path coverage):

- **`claim_task`** — permissionless first-come-first-served claiming, with
  re-claim allowed only after the prior claimer's lock window elapses.
- **`execute_task`** — execution-proof submission, reward split between keeper
  and protocol fee, and CEI-safe keeper crediting.
- **`cancel_task`** — owner reclaims escrow of a still-Pending task.
- **`expire_task`** — permissionless deadline enforcement; anyone can refund a
  stuck task's escrow to its owner after the deadline.
- **`withdraw_rewards`** — keeper pulls its accrued balance (balance zeroed
  before transfer to prevent re-entrant double-spend).
- **`sweep_fees`** + `FeesAccrued` accumulator — admin moves accrued protocol
  fees to a treasury; can never touch task escrow or keeper balances.
- **Admin controls** — `pause`/`unpause` (funds-recovery paths stay open during
  a pause), `set_fee_bps` (bounded, future-effective), `transfer_admin` (dual
  auth to prevent lock-out), and `upgrade`.
- **Views** — `fees_accrued`, alongside the existing task/keeper/state views.

### Added — keeper-bot

- Retry with exponential back-off + jitter on transient RPC errors, skipping
  retries on permanent contract errors.
- Graceful shutdown (SIGINT/SIGTERM) that drains the in-flight round so a task
  is never left claimed-but-unexecuted.
- Optional permissionless expiry of past-deadline tasks to refund owners.

### Fixed

- Pinned `ed25519-dalek` to 2.2.0 and committed `Cargo.lock` so the test build
  is reproducible (`soroban-env-host` was resolving an incompatible 3.0.0).
