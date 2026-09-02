# CI

What every job in `.github/workflows/ci.yml` does, and which ones can fail
without blocking your PR.

## Required vs. advisory

| Job | Gate | Why |
|-----|------|-----|
| `format` | Required | `cargo fmt --all -- --check` — a formatting diff is trivially fixable and shouldn't need discussion. |
| `test` | Required | `cargo test --workspace --locked` — the test suite is the correctness bar. |
| `build-wasm` | Required | The contract must actually compile to the `wasm32-unknown-unknown` target it deploys to. |
| `sdk-ts` | Required | The TypeScript SDK (`packages/sdk-ts`) must build, pass its own test suite, and lint clean. Uploads its built `dist/` as an artifact for `bot` to consume. |
| `bot` | Required | The example keeper bot (`examples/keeper-bot`) must lint, syntax-check, and pass its own test suite. Depends on `sdk-ts`'s built output (the bot's `@soroban-keeper-network/sdk` dependency is a local `file:` reference, which `npm install` copies as-is rather than building). |
| `indexer` | Required | The indexer service (`indexer/`) must format, build, and pass its test suite, including the database-backed tests. See [The indexer job](#the-indexer-job). |
| `clippy` | Advisory (`continue-on-error: true`) | Lints are useful but subjective enough that a maintainer should decide case-by-case, not have every PR blocked by a new upstream lint. |
| `audit` | Advisory (`continue-on-error: true`) | A new upstream dependency CVE should notify maintainers, not fail every open PR the moment it's published. |
| `wasm-size` | Advisory (`continue-on-error: true`) | Reports binary size for visibility; see below. |
| `sdk-ts` | Advisory (`continue-on-error: true`) | Builds and smoke-tests `packages/sdk-ts` (the TypeScript SDK scaffold, backlog 0151). Advisory until backlog 0187 adds a dedicated typecheck/lint job with its own required/advisory split. |
| `wasm-size` | Advisory (`continue-on-error: true`) | Reports contract binary size for visibility; see below. |
| `sdk-bundle-size` | Advisory (`continue-on-error: true`) | Reports the SDK's minified+gzipped bundle size for visibility — the frontend analogue of `wasm-size`; see below. |

`ci-required` is the single check branch protection should require — it
passes only when `format`, `test`, `build-wasm`, `sdk-ts`, `bot`, and
`indexer` all succeed, and ignores the advisory jobs' outcomes entirely.

Run every required check locally before opening a PR:

```bash
make ci
```

## The indexer job

The `indexer` job covers `indexer/` the way `bot` covers the example keeper
bot: formatting, a build, and the crate's own test suite.

It runs only when a PR touches `indexer/` or the workspace manifest
(`Cargo.toml` / `Cargo.lock`, which can change how the indexer builds). A
contract-only PR skips the work — but unlike the advisory `fuzz-pr` job, a
skip still reports success, which is what lets `indexer` be a required check
without blocking contract-only work.

### The ephemeral database

The indexer's interesting tests are database tests: the `ON CONFLICT`
idempotency constraint, the balance view's arithmetic, and the "latest event
of each kind wins" ordering are all properties of Postgres, not of the Rust
around it. Mocking them would only assert that the code sends the SQL it
sends.

So the job declares a Postgres **service container**, created for that job and
destroyed with it. It is deliberately not a shared instance: these tests drop
and recreate their tables on every run, so a shared database would let
concurrent CI runs corrupt each other and make a green result depend on what
else happened to be running at the time.

The container declares a `pg_isready` health check. Without it the job can
start querying before Postgres accepts connections, which surfaces as a
confusing connection error instead of a wait.

### Why the tests skip without a database

The database-backed tests read `INDEXER_TEST_DATABASE_URL`. When it is unset
they **skip rather than fail**, because the required `test` job runs
`cargo test --workspace` on a runner with no Postgres, and a contract
contributor running `make ci` on their laptop does not have one either.
Neither should go red over a database they were never expected to have.

That skip is a hole worth closing on the one runner that *does* have a
database: a test that skips itself still exits 0, so a mistyped connection URL
would turn the whole suite into a silent no-op while the job stayed green. The
job therefore asserts the skip notice does **not** appear in the test output,
and fails if it does. A green `indexer` job means the database tests really
ran.

To run them locally, point the variable at any throwaway Postgres:

```bash
docker run -d --name kn-pg -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=indexer_test -p 5432:5432 postgres:16

INDEXER_TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/indexer_test \
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
`contracts/keeper-registry/src/test.rs` rather than a separate CI job — see
the "CPU-instruction regression ceilings" section of that file for the
reasoning and the margin chosen. These run as part of the required `test`
job like any other test.

## Mutation testing (evaluated, not adopted yet)

No CI job runs mutation testing today. [`docs/MUTATION_TESTING.md`](MUTATION_TESTING.md)
evaluates whether `cargo-mutants` is practical against
`contracts/keeper-registry`'s `#![no_std]` Soroban contract crate and its
test suite: the recommendation there is conditional adoption as a
periodic, advisory job (same non-blocking posture as `fuzz-nightly.yml`),
pending a first real timed run to confirm the open questions that
evaluation raises.
