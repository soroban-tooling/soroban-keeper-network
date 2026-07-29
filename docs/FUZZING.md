# Fuzzing & Property Testing

This document covers the fuzz harness (`fuzz/`), the property tests in
`contracts/keeper-registry/src/test.rs`, and the shared invariant module
both use. It documents what actually exists today, not the full eventual
scope of the fuzzing epic (E03) — see the "What's not here yet" section at
the end for what's still open.

## Prerequisites

Fuzzing with `cargo-fuzz` requires the **nightly** Rust toolchain (it needs
`-Z sanitizer=address` and sanitizer-coverage flags that are nightly-only):

```bash
rustup toolchain install nightly
cargo install cargo-fuzz
```

Everything else (`cargo test`, the property tests) runs on the same stable
toolchain as the rest of the workspace — only actually driving `cargo fuzz
run`/`build` needs nightly.

## Running an existing fuzz target locally

```bash
# From the repo root (not from inside fuzz/ — cargo-fuzz expects a
# `fuzz/Cargo.toml` relative to the invocation directory):
cargo +nightly fuzz run execute_task
```

Leave it running in a terminal; `libFuzzer` prints a summary line per
iteration count and keeps going until you stop it (Ctrl-C) or it finds a
crash. For a bounded local check rather than an open-ended session:

```bash
cargo +nightly fuzz run execute_task -- -max_total_time=120
```

**How long is "enough"?** There's no fixed answer, but as a rule of thumb:
a change to a fuzz target's own logic, or to the specific contract
function it exercises, deserves at least a few minutes locally before you
push — long enough for `libFuzzer` to move past its initial corpus and
start finding genuinely new code paths (watch the `cov:` counter in its
output; it should keep climbing for a while, then plateau). A drive-by
change elsewhere in the contract that the target only indirectly touches
doesn't need a fresh fuzzing session for every commit — CI is expected to
run the real, longer sessions (see "CI vs. local expectations" below).

### Target status

| Target | Status |
|---|---|
| `execute_task` | Compiles and runs cleanly. Exercises `execute_task`'s proof handling and, via the shared `invariants` module, I-1 (solvency, restricted to the executed task) and I-4 (fee bounding). |
| `register_task` | **Currently does not compile** (pre-existing, not introduced by this change) — its `try_register_task` result-nesting doesn't match this `soroban-sdk` version's generated client, and it uses a `usize`/`u32` comparison that doesn't type-check. Needs a fix pass before it can be run; left as-is here since fixing the *content* of a different target is outside this document's scope. |
| `smoke` | **Currently does not compile** (pre-existing) — calls `client.get_admin()` / `client.get_reward_token()`, which don't exist on the generated client (the real accessors are `admin()` / `reward_token_address()`, both returning `Option<Address>`), and `Env::address_is_contract`, which doesn't exist in this SDK version's `testutils` at all. |

If you're picking up `register_task` or `smoke` as a fix: `cargo check
--features arbitrary,libfuzzer-sys --bin <name>` from `fuzz/` (with `RUSTFLAGS="--cfg
fuzzing"` set, since `cfg(fuzzing)`-gated items like `keeper_registry::invariants`
are otherwise configured out) reproduces the compile errors without needing
nightly or an actual fuzzing run.

## Adding a new fuzz target

1. Add a `#![no_main]` file under `fuzz/fuzz_targets/<name>.rs`.
2. Register it as a `[[bin]]` in `fuzz/Cargo.toml` (this repo's fuzz crate
   lives at a non-standard path — `fuzz/` directly under the repo root
   rather than `<crate>/fuzz/` — so targets must be declared explicitly
   rather than relying on `cargo fuzz`'s directory auto-discovery).
3. Use `keeper_registry_fuzz::support::RegistryHarness::new()` for setup —
   don't hand-roll environment/contract deployment in the target itself.
   `RegistryHarness` gives you a deployed, initialized registry with a
   funded reward token and three deterministic addresses (`admin`, `user`,
   `keeper`).
4. Use `arbitrary_bytes` / `arbitrary_task_type` (also in `support.rs`) to
   turn fuzzer-supplied bytes into `Bytes` / `TaskType` values, and
   `is_calldata_valid` / `is_proof_valid` to check a value against the
   contract's own length bounds before asserting on it.
5. If your target's success case can be checked against one of the `I-1`
   through `I-7` money invariants (see `docs/ARCHITECTURE.md`), call the
   matching `assert_*` function from `keeper_registry::invariants` rather
   than re-deriving the check inline — see `fuzz_targets/execute_task.rs`
   for a worked example (it calls `assert_fee_bounded` for I-4).
6. Match `try_*` client method results carefully: the generated shape is
   `Result<Result<T, ConversionError>, Result<KeeperError, InvokeError>>` —
   the contract's typed error lives in the **outer `Err`'s `Ok`**
   (`Err(Ok(KeeperError::SomeVariant))`), not where you might first guess.
   Getting this backwards produces a type error pointing at the wrong
   variant, which is exactly the class of bug this document's "Target
   status" table above is full of.

## Using the shared invariant module

`contracts/keeper-registry/src/invariants.rs` exposes one `assert_*`
function per named invariant in `docs/ARCHITECTURE.md`'s `I-1`..`I-7` list.
Both the property tests in `test.rs` and fuzz targets call these — never
duplicate the assertion logic inline in a new test or target. See
`invariants.rs`'s own module doc for why (issue #93 / backlog 0068), and
the property tests in `test.rs` (search for `proptest!`) for how they're
used from the test side.

**Adding a new property.** The stateful, multi-task/multi-keeper
model-checking harness (backlog 0061) that would let you generate and
replay arbitrary *sequences* of contract calls doesn't exist yet — it's
still open, separately-scoped work. Until it lands, new properties in this
repo are written directly with `proptest!`, generating the *inputs* to a
short, fixed sequence of calls (see any `property_i*` test in `test.rs`
for the pattern: generate a reward and/or a small `Vec` of them, apply a
fixed handful of calls, then assert one of the `invariants.rs` functions
holds). This is deliberately narrower than full sequence-shrinking model
checking — it catches "this specific invariant breaks for this input,"
not "this arbitrary sequence of N calls breaks something." Extend the
existing `property_i*` tests in place, in the same style, until the
stateful harness exists and a wider rewrite becomes worthwhile.

## Crash-to-regression convention

See `CONTRIBUTING.md`'s "Fuzzing & crash-to-regression convention" section
for the full process: minimize the crash, commit it under
`fuzz/corpus/<target>/regressions/`, and add a human-readable `#[test]`
reproduction — never just a fixed line of contract code with no permanent
test artifact. No crash has been found or committed yet (the fuzz crate
did not compile at all until the fixes accompanying this document — see
below); the first one to land should follow that convention as the
worked example.

## CI vs. local expectations

**Not wired up yet.** A time-boxed fuzz job in PR CI, with a longer
nightly scheduled job, is tracked separately (backlog 0066) and hasn't
landed — there is currently no automatic fuzzing in this repo's CI at all.
`docs/CI.md` (backlog 0043, the general "what runs where" guide this
section would otherwise cross-reference) also doesn't exist yet.

Until both land, treat fuzzing as an entirely manual, local step: if
you're touching `execute_task` (the only currently-working target) or the
shared `invariants` module, run `cargo +nightly fuzz run execute_task -- -max_total_time=120`
locally before opening a PR. `cargo test -p keeper-registry` (which
includes the `proptest!`-based property tests) *is* run in ordinary CI
today, same as any other unit test — that part isn't optional or
fuzzing-specific.

## What's not here yet

For anyone picking up the remaining fuzzing-epic issues, in dependency
order:

- **`register_task` and `smoke` fuzz targets don't currently compile** (see
  the table above) — fixing these is real, scoped work of its own.
- **The stateful model-checking harness** (backlog 0061) for generating
  and replaying arbitrary multi-call sequences, rather than fixed
  sequences with fuzzed inputs.
- **The full I-1..I-7 property test suite** (backlog 0054–0060) — this
  repo currently has one compact `proptest!` per invariant (see
  `test.rs`), not the exhaustive, sequence-driven exploration those
  issues call for.
- **A CI fuzz job** (backlog 0066) and **`docs/CI.md`** (backlog 0043).
- **A committed crash corpus** under `fuzz/corpus/*/regressions/` — none
  exists yet, since no crash has been found and minimized.
