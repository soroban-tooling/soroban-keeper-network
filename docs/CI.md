# CI

What every job in `.github/workflows/ci.yml` does, and which ones can fail
without blocking your PR.

## Required vs. advisory

| Job | Gate | Why |
|-----|------|-----|
| `format` | Required | `cargo fmt --all -- --check` — a formatting diff is trivially fixable and shouldn't need discussion. |
| `test` | Required | `cargo test --workspace --locked` — the test suite is the correctness bar. |
| `build-wasm` | Required | The `keeper-registry` and `keeper-treasury` contracts must actually compile to the `wasm32-unknown-unknown` target they deploy to. |
| `sdk-ts` | Required | The TypeScript SDK (`packages/sdk-ts`) must typecheck (`tsc --noEmit`), build, and pass its own test suite. Uploads its built `dist/` as an artifact for `bot` to consume. Lint is the advisory `sdk-ts-lint` job. See [SDK typecheck and lint](#sdk-typecheck-and-lint). |
| `bot` | Required | The example keeper bot (`examples/keeper-bot`) must lint, syntax-check, and pass its own test suite. Depends on `sdk-ts`'s built output (the bot's `@soroban-keeper-network/sdk` dependency is a local `file:` reference, which `npm install` copies as-is rather than building). |
| `bot-v2` | Required | The production keeper bot v2 (`examples/keeper-bot-v2`) must build, lint, and pass its test suite against an ephemeral Postgres service container. See [The keeper-bot-v2 job](#the-keeper-bot-v2-job). |
| `indexer` | Required | The indexer service (`indexer/`) must format, build, and pass its test suite, including the database-backed tests. See [The indexer job](#the-indexer-job). |
| `rust-sdk` | Required | The Rust SDK crate (`rust-sdk/`) must compile and pass all unit and integration tests. |
| `rust-sdk-quickstart` | Advisory (`continue-on-error: true`) | On pushes to `main`, deploys the registry to a local Stellar Quickstart network and runs the opt-in Rust SDK lifecycle test. |
| `indexer-client` | Required | The indexer's TypeScript client (`packages/indexer-client`) must typecheck, build, test and lint, and its generated types must match `indexer/openapi.yaml`. |
| `clippy` | Advisory (`continue-on-error: true`) | Lints are useful but subjective enough that a maintainer should decide case-by-case, not have every PR blocked by a new upstream lint. |
| `audit` | Advisory (`continue-on-error: true`) | A new upstream dependency CVE should notify maintainers, not fail every open PR the moment it's published. |
| `deny` | Advisory (`continue-on-error: true`) | License allow-list enforcement, duplicate crate version detection, yanked crate warnings, and source validation via `cargo-deny`. See [Cargo-deny](#cargo-deny) below. |
| `wasm-size` | Advisory (`continue-on-error: true`) | Reports binary size for visibility; see below. |
| `sdk-ts-lint` | Advisory (`continue-on-error: true`) | `npm run lint` (ESLint) on `packages/sdk-ts`. Lint findings are subjective enough that a maintainer should decide case-by-case, the same reasoning as `clippy`. See [SDK typecheck and lint](#sdk-typecheck-and-lint). |
| `sdk-bundle-size` | Advisory (`continue-on-error: true`) | Reports the SDK's minified+gzipped bundle size for visibility — the frontend analogue of `wasm-size`; see below. |
| `sdk-ts-docs` | Advisory (`continue-on-error: true`) | `npm run docs:check` (TypeDoc) on `packages/sdk-ts`; reports exported symbols missing a doc comment in the job summary. |
| `fuzz-pr` | Advisory (`continue-on-error: true`) | A short fuzz run on PRs touching `contracts/keeper-registry/` or `fuzz/`; `fuzz-nightly.yml` is the longer counterpart. |
| `resource-cost` | Advisory (`continue-on-error: true`) | Reports CPU instructions and memory per state-changing entry point against a checked-in baseline. |

`ci-required` is the single check branch protection should require — it
passes only when `format`, `test`, `build-wasm`, `sdk-ts`, `bot`, `bot-v2`, `indexer`, `rust-sdk`, and
`indexer-client` all succeed, and ignores the advisory jobs' outcomes entirely.

Run every required check locally before opening a PR:

```bash
make ci
```

`make ci` covers blocking checks only, so it does not lint the SDK. `make check`
runs `make ci` plus the advisory lints (`make lint` for clippy, `make sdk-ts-lint`
for the SDK's ESLint).

## Rust SDK Quickstart integration

`rust-sdk/tests/integration_quickstart.rs` deploys a fresh registry to a local
Quickstart network and drives register, claim, execute, and withdraw through
`KeeperRegistryClient`. It checks the registry's native-token balance after
every transition. The test is opt-in so ordinary local and pull-request test
runs do not require Docker or a live RPC.

Run it after starting a local Quickstart network and building the contract:

```bash
cargo build --locked --release --target wasm32-unknown-unknown --package keeper-registry
SKN_INTEGRATION_RPC_URL=http://localhost:8000/rpc \
  cargo test --locked --package soroban-keeper-sdk \
  --test integration_quickstart -- --nocapture
```

When `SKN_INTEGRATION_RPC_URL` is unset, the test prints a visible skip notice
and returns successfully. The advisory `rust-sdk-quickstart` job sets it and
runs only on pushes to `main`; outages or image/toolchain drift are reported
without becoming part of the required `ci-required` aggregate.

## SDK typecheck and lint

`packages/sdk-ts` is gated the way the Rust side is:

| Check | Job | Gate | Rust analogue |
|-------|-----|------|---------------|
| `tsc --noEmit -p tsconfig.json` | `sdk-ts` | Required | `format` (`cargo fmt --check`) |
| `npm run lint` (ESLint) | `sdk-ts-lint` | Advisory | `clippy` |

A type error fails `sdk-ts`, and through it `ci-required`, so it blocks the
merge. A lint finding fails only `sdk-ts-lint`, which is `continue-on-error`, so
it shows as a failed check on the PR but does not block it.

ESLint reads the flat config at `packages/sdk-ts/eslint.config.cjs`, the same
flat-config pattern as `examples/keeper-bot/eslint.config.js` (no legacy
`.eslintrc`). It is `.cjs` rather than `.js` because `packages/sdk-ts` declares
`"type": "module"`, which would make a `.js` config an ES module and break its
`require` calls; `examples/keeper-bot` is CommonJS, so its config can be `.js`.

To reproduce locally:

```bash
make sdk-ts        # typecheck + build + test (required)
make sdk-ts-lint   # ESLint (advisory)
```

## Cargo-deny

The `deny` job runs `cargo deny check` to enforce:

- **Licenses**: Every crate in the dependency graph must have a license in the allow-list (`deny.toml`). New dependencies must declare an OSI-approved license (MIT, Apache-2.0, BSD, etc.). Copyleft licenses (GPL, AGPL) are denied by policy.
- **Bans**: Duplicate major versions of the same crate are reported as warnings, so the dependency tree remains minimal. A crate is rejected only if it is explicitly denied in `deny.toml`.
- **Advisories**: Security advisories and yanked (unpublished) crates are reported as warnings, matching the advisory-first posture of the `audit` job.
- **Sources**: Crates must come from `crates.io` or explicitly approved git repositories. Unusual sources (private registries, mirrors) are flagged.

This is an **advisory-first rollout**: findings appear in the job summary but do not block the PR. Over time, as findings are reviewed and triaged, the job can be changed to `deny` (blocking) via `.github/workflows/ci.yml`.

### License allow-list

The allow-list in `deny.toml` is constructed from **actual project usage**: every license that appears in the workspace's dependency graph today. To add a new dependency with a previously-unseen license:

1. Run `cargo add <crate>` in the workspace.
2. Run `cargo deny check licenses` locally.
3. If the license is new:
   - Check if it is a common permissive license (MIT, Apache-2.0, BSD, MPL-2.0).
   - If it is restrictive (GPL, AGPL) or non-standard, open an issue or discussion for maintainer approval first.
   - Once approved, add the SPDX identifier to the `allow` list in `deny.toml` with a comment explaining why (e.g., "required by the indexer's database bindings").

### Updating the policy

To make the `deny` job blocking (required):

1. Update `.github/workflows/ci.yml` to remove `continue-on-error: true` from the `deny` job.
2. Update the table in this doc to change `deny` from "Advisory" to "Required".
3. Open a PR and confirm all advisories and license mismatches have been reviewed.

### Running locally

```bash
# Check licenses only
cargo deny check licenses

# Check for duplicate versions, yanked crates, and advisories
cargo deny check

# Detailed output with statistics
cargo deny check --show-stats
```

See [`https://embarkstudios.github.io/cargo-deny/`](https://embarkstudios.github.io/cargo-deny/) for full `cargo-deny` documentation.

## WASM size tracking

The `wasm-size` job builds the release WASM, runs it through `wasm-opt -Oz`

The `bot-v2` job covers `examples/keeper-bot-v2`: TypeScript compilation (`npm run build`), linting (`npm run lint`), and its test suites (`npm test`: vitest for the TypeScript service in `src/`, then `node --test` for the CommonJS components in `bot/`).

It runs on PRs touching `examples/keeper-bot-v2/`, `packages/sdk-ts/` (which it depends on via a built distribution artifact), or the CI workflow manifest `.github/workflows/ci.yml`. PRs touching only contract or indexer code skip the work while reporting success, allowing `bot-v2` to remain a required gate in `ci-required`.

### Ephemeral database for keeper-bot-v2

Like the indexer service, keeper-bot-v2 includes persistent state storage for tracking task execution history and avoiding duplicate submissions across restarts.

In CI, the job provisions a dedicated, ephemeral PostgreSQL service container (`postgres:16`) on `localhost:5432` with health checks (`pg_isready`). Tests connect via `DATABASE_URL=postgresql://postgres:postgres@localhost:5432/keeper_bot_v2_test`, run migrations idempotently, exercise state persistence, and clean up afterwards without interfering with other jobs or shared environments.

When `DATABASE_URL` is unset locally during development, database-dependent tests log an informative skip notice while unit tests continue to pass.

## The indexer job

The `indexer` job covers `indexer/` the way `bot` covers the example keeper
bot: formatting, a build, and the crate's own test suite.

It runs only when a PR touches `indexer/` or the workspace manifest
(`Cargo.toml` / `Cargo.lock`, which can change how the indexer builds). A
contract-only PR skips the work — but unlike the advisory `fuzz-pr` job, a
skip still reports success, which is what lets `indexer` be a required check
without blocking contract-only work.

### No database service

The indexer stores everything in SQLite, so its tests use in-memory databases
and need no service container. `tests/service_process.rs` also starts the real
`keeper-indexer` binary against a mock Soroban RPC on localhost, so the job
exercises the same startup and shutdown path an operator gets. Nothing in the
suite needs a network beyond loopback.

To run it locally:

```bash
cargo test --package keeper-indexer
```

## WASM size tracking

The `wasm-size` job builds the release WASM, runs it through `wasm-opt -Oz`
(the same optimization `stellar contract optimize` applies), and reports the
raw and optimized byte sizes in the job summary.

The optimized size is compared against a committed baseline,
`.github/wasm-size-baseline.txt`, so the summary shows a delta (bytes and
percentage) rather than just an absolute number a reviewer has to remember
context for. A PR that grows the optimized size by **5% or more** relative to
the baseline gets a `:warning:` line in the summary. 5% is picked because
ordinary incremental work (a new field, an extra guard clause) moves the
optimized binary by a small fraction of a percent — a jump past that either
reflects a deliberate feature landing (worth a reviewer's attention, not a
block) or an accidental regression (e.g. debug info or an unintended
dependency leaking into the release profile). This never fails the job or
the PR — it is advisory, same as the rest of `wasm-size`.

### Updating the baseline

If your PR intentionally grows the contract (a new entry point, a new
field), update the baseline in the same PR so the next PR's delta is
measured against your new normal, not a stale one:

1. Run the same optimize step the CI job runs, e.g. locally:
   ```bash
   cargo build --locked --release --target wasm32-unknown-unknown --package keeper-registry
   stellar contract optimize --wasm target/wasm32-unknown-unknown/release/keeper_registry.wasm
   ```
   (or read the "release + wasm-opt -Oz" byte figure straight off your PR's
   own `wasm-size` job summary once CI has run).
2. Replace the number in `.github/wasm-size-baseline.txt` with that figure.
3. Mention the baseline bump in your PR description so a reviewer knows the
   size growth was deliberate, not overlooked.

## SDK bundle size tracking

The `sdk-bundle-size` job bundles `packages/sdk-ts`'s built `dist/index.js`
with esbuild (minified, `@stellar/stellar-sdk` marked external — see that
job's own script, `packages/sdk-ts/scripts/report-bundle-size.mjs`, for why
the peer dependency is excluded), gzips the result, and reports both figures
in the job summary — the same baseline-and-delta shape as `wasm-size`,
against `packages/sdk-ts/bundle-size-baseline.json`. A change of **10% or
more** relative to the baseline gets a `:warning:` line. This is advisory
only, same as `wasm-size`.

### Updating the SDK bundle-size baseline

```bash
cd packages/sdk-ts
npm run build
node scripts/report-bundle-size.mjs --baseline
```

Commit the updated `bundle-size-baseline.json` and mention the bump in your
PR description.

## Resource-cost visibility

Per-entry-point CPU-instruction ceilings for the hottest contract functions
(`claim_task`, `execute_task`) are pinned as regular `#[test]`s in
`contracts/keeper-registry/src/test/perf.rs` rather than a separate CI job
— see that file for the reasoning and the margin chosen. These run as part
of the required `test` job like any other test.

## Mutation testing (evaluated, not adopted yet)

No CI job runs mutation testing today. [`docs/MUTATION_TESTING.md`](MUTATION_TESTING.md)
evaluates whether `cargo-mutants` is practical against
`contracts/keeper-registry`'s `#![no_std]` Soroban contract crate and its
test suite: the recommendation there is conditional adoption as a
periodic, advisory job (same non-blocking posture as `fuzz-nightly.yml`),
pending a first real timed run to confirm the open questions that
evaluation raises.
