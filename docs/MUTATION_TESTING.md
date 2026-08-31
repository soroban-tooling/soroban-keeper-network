# Mutation testing evaluation (issue #204)

This is an evaluation, not a commitment: does mutation testing make sense
for `contracts/keeper-registry`'s test suite, and is a tool practical to run
against a `#![no_std]` Soroban contract crate. See [`docs/CI.md`](CI.md) for
where this fits alongside the other advisory/required jobs.

## Why coverage isn't enough

`cargo-llvm-cov` (the coverage tooling already wired up per issue 0030/0137)
answers "did this line run during the test suite." It cannot answer "would
the test suite actually notice if this line were wrong." A line can be
covered by a dozen tests and still have a bug no assertion checks for — a
`>=` that should be `>`, a `+` that should be `-`, a constant that's off by
one. Mutation testing answers that second question directly: it deliberately
introduces a small, mechanical bug (a "mutant" — flip a comparison operator,
negate a boolean, change a return value) at one call site, reruns the test
suite, and records whether any test failed. A mutant the suite doesn't catch
("survived") marks a spot where coverage exists but the assertion covering
it doesn't, which is a much sharper signal for where to add a test than
coverage percentage alone.

## Tooling survey

`cargo-mutants` is the only actively maintained, general-purpose mutation
tester for Rust as of this evaluation. It works by:

1. Parsing the crate's source with `syn` (not the macro-expanded output), so
   it operates on the Rust text a contributor actually wrote.
2. Generating mutants per function: replacing a function body with a
   type-appropriate stub return (e.g. `Ok(Default::default())`,
   `Default::default()`, a fixed literal), and separately mutating
   comparison/arithmetic/boolean operators in expressions.
3. For every mutant: copying the source tree, applying the one-line change,
   running `cargo build` then `cargo test` against the mutated copy, and
   recording whether the build failed (an "unviable" mutant — discarded, not
   counted as a finding), the tests failed (caught), or the tests passed
   (survived — the interesting case).

There isn't a second option worth surveying alongside it: the other
historically-known Rust mutation tools (`mutagen`, the various
`cargo-mutate` prototypes) are unmaintained or require nightly-only compiler
plugin hooks that don't track current stable Rust, which `cargo-mutants`
specifically avoids by operating source-to-source rather than through
compiler internals.

## Feasibility against this crate

This section is a structural read of `contracts/keeper-registry`'s actual
layout and `Cargo.toml`, not a report of a live `cargo-mutants` run — see
"What this evaluation did not do," below, for why and what running it for
real would take.

**The `#![no_std]` attribute is not the obstacle it looks like.** `lib.rs`
is unconditionally `#![no_std]` for the on-chain `cdylib` target, but the
crate already builds and tests cleanly under `cargo test` today — the
`[dev-dependencies]` block pulls in `soroban-sdk`'s `testutils` feature
unconditionally, and the `#[cfg(test)]`/`#[cfg(any(test, fuzzing))]` modules
(`test/`, `invariants.rs`, `mocks.rs`) pull in `extern crate std;`
explicitly where they need it (`std::format`/`std::string::String` in
`invariants.rs`, for instance). `cargo-mutants` drives ordinary `cargo
build`/`cargo test` the same way CI's required `test` job already does, so
whatever makes `cargo test -p keeper-registry` work today should make a
mutated copy build and test the same way — this isn't a new toolchain
requirement the way `cargo fuzz` needing nightly ASan support is.

**The real friction is `#[contractimpl]`/`#[contracterror]`-generated code
and this crate's dual `cdylib`/`rlib` crate type.** Three specific concerns,
none of which are fatal but all of which need to be confirmed by an actual
run rather than assumed away:

- Whole-function-body mutation needs a stub value of the function's return
  type. Every mutating entry point returns `Result<T, KeeperError>` (or
  `Result<Vec<u64>, KeeperError>`, etc.) — `KeeperError` has no `Default`
  impl (see `errors.rs`; it's a `#[contracterror]` enum whose discriminants
  are the published ABI, deliberately not derived from anything). Whether
  `cargo-mutants` synthesizes `Err(KeeperError::AlreadyInitialized)` (the
  first/lowest-discriminant variant, a common "pick the first enum variant"
  fallback), refuses to generate that mutant category and skips it, or
  produces an unviable (non-compiling) mutant that gets silently discarded
  is a real open question — the answer changes how much of this crate's
  mutant population is even meaningful analysis versus noise, and it can
  only be answered by running it.
- `#[contractimpl]` expands each `pub fn` into both the original function
  and dispatch/spec-XDR scaffolding. `cargo-mutants` mutates pre-expansion
  source, so this should be transparent to it in principle — but this
  project has no track record yet of running `cargo-mutants` against
  `#[contractimpl]`-heavy code specifically, so "should be transparent"
  is exactly the kind of claim this issue's acceptance criteria are right
  to insist on confirming empirically rather than accepting on paper.
- The `cdylib` half of `crate-type = ["cdylib", "rlib"]` exists for the
  `wasm32-unknown-unknown` release build; `cargo-mutants`' build/test cycle
  runs against the host target (same as `cargo test`), so the `cdylib`
  target shouldn't be built or mutated in that path at all. Worth
  confirming with `cargo mutants --list` (which enumerates planned mutants
  without building anything) before committing to a full run, since a
  misconfiguration here would silently inflate the mutant count with
  WASM-target-only code that a host-side `cargo test` run can never
  exercise anyway.

**Scale.** `contracts/keeper-registry/src` has roughly 1,900 lines of
non-test contract source across `admin.rs`, `batch.rs`, `constants.rs`,
`errors.rs`, `events.rs`, `internal.rs`, `lib.rs`, `task.rs`, `types.rs`, and
`views.rs`, exercised by 160+ `#[test]` functions plus one `proptest!` block
(`test/property.rs`) that itself runs many generated cases per invocation.
Each mutant requires a full rebuild plus a full test-suite run; with a test
suite this size, a mutant population in the hundreds (this crate's
`Result`-returning-function count alone, before counting operator mutations,
comfortably reaches that) means a full run is very plausibly a
multi-minute-to-tens-of-minutes job, not a per-PR one. `cargo-mutants`
supports parallelism (`--jobs`) and incremental re-runs limited to a
changed file (`--file`), both of which help but don't change the order of
magnitude for a first full-crate baseline run.

## What this evaluation did not do

This project's current contribution workflow for this change does not
execute `cargo build`/`cargo test` (or anything that drives them, which
`cargo-mutants` inherently does) as part of authoring a documentation
change — review here is manual/static only. That means this evaluation
could not do what its own acceptance criteria ultimately ask for: install
`cargo-mutants`, run it against `contracts/keeper-registry` for real, and
report the actual wall-clock time and actual list of surviving mutants
(fixing any real one found with a new test, per this issue's third
criterion). Everything above is a grounded reading of the crate's actual
configuration and code, not a substitute for that run — it is deliberately
scoped to "here is exactly what running it would involve and where it could
go sideways," so that whoever does the first real run has a concrete
checklist rather than a blank slate, in the same spirit as
`docs/VERIFIERS.md`'s "this is a partial answer" section for a different
blocked measurement.

## Recommendation

**Conditionally adopt, as a periodic (not per-PR) CI job — pending a first
real timed run to confirm the concerns above rather than commit to a
schedule blind.**

Reasoning:

- The technique answers a real gap coverage can't (assertion strength, not
  just line execution), and this crate's escrow/refund/fee-split logic is
  exactly the kind of code where a flipped comparison or off-by-one is high
  value to catch and easy to introduce silently in review.
- The likely per-run cost (plausibly tens of minutes for a full-crate
  baseline, per the scale estimate above) is the same shape of cost
  `fuzz-nightly.yml` already accepts for fuzzing: too slow to gate every PR
  the way `format`/`test`/`build-wasm` do, but cheap enough as a scheduled
  job that nobody is blocked waiting on it, mirroring the
  advisory-vs-required split `docs/CI.md` already documents for `clippy`,
  `audit`, and `wasm-size`.
- It should **not** be adopted per-PR: unlike `clippy`/`audit`, mutation
  testing's runtime scales with the size of the mutant population, not with
  the size of a single PR's diff, so gating individual PRs on it would slow
  down every contributor for a check whose value is in periodically
  resurfacing weak spots, not in blocking any one change.
- Before wiring up a scheduled job (mirroring `fuzz-nightly.yml`'s daily
  cadence and non-blocking `continue-on-error` posture), a maintainer should
  run `cargo mutants --list` and then a real timed `cargo mutants` pass
  locally against `contracts/keeper-registry` to resolve the open questions
  above (stub-value generation for `KeeperError`-returning functions,
  interaction with `#[contractimpl]` expansion, actual wall-clock cost) and
  fix any real surviving mutant it finds, per this issue's acceptance
  criteria, as the concrete follow-up this document sets up rather than
  completes.
