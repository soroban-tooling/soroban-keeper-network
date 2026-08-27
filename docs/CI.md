# CI

What every job in `.github/workflows/ci.yml` does, and which ones can fail
without blocking your PR.

## Required vs. advisory

| Job | Gate | Why |
|-----|------|-----|
| `format` | Required | `cargo fmt --all -- --check` — a formatting diff is trivially fixable and shouldn't need discussion. |
| `test` | Required | `cargo test --workspace --locked` — the test suite is the correctness bar. |
| `build-wasm` | Required | The contract must actually compile to the `wasm32-unknown-unknown` target it deploys to. |
| `bot` | Required | The example keeper bot (`examples/keeper-bot`) must lint, syntax-check, and pass its own test suite. |
| `clippy` | Advisory (`continue-on-error: true`) | Lints are useful but subjective enough that a maintainer should decide case-by-case, not have every PR blocked by a new upstream lint. |
| `audit` | Advisory (`continue-on-error: true`) | A new upstream dependency CVE should notify maintainers, not fail every open PR the moment it's published. |
| `wasm-size` | Advisory (`continue-on-error: true`) | Reports binary size for visibility; see below. |

`ci-required` is the single check branch protection should require — it
passes only when `format`, `test`, `build-wasm`, and `bot` all succeed, and
ignores the advisory jobs' outcomes entirely.

Run every required check locally before opening a PR:

```bash
make ci
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
