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
| `execute_task` | Compiles and runs cleanly. Exercises `execute_task`'s proof handling and, via the shared `invariants` module, I-1 (solvency, restricted to the executed task) and I-4 (fee bounding). Proof length is weighted at and around `MAX_PROOF_LEN`'s boundary (issue 0123), and every acceptance is checked against the emitted `TaskExecuted` event's proof field byte-for-byte. |
| `uninitialized_registry` | Compiles and runs cleanly. Deploys a registry that `initialize` is deliberately never called on, then drives every mutating entry point (issue 0121) in a fuzzer-chosen order and asserts each returns a typed `KeeperError` (`NotInitialized` or an earlier-checked variant like `TaskNotFound`) — never a panic, never a success. |
| `register_task` | **Currently does not compile** (pre-existing, not introduced by this change) — its `try_register_task` result-nesting doesn't match this `soroban-sdk` version's generated client, and it uses a `usize`/`u32` comparison that doesn't type-check. Needs a fix pass before it can be run; left as-is here since fixing the *content* of a different target is outside this document's scope. |
| `smoke` | **Currently does not compile** (pre-existing) — calls `client.get_admin()` / `client.get_reward_token()`, which don't exist on the generated client (the real accessors are `admin()` / `reward_token_address()`, both returning `Option<Address>`), and `Env::address_is_contract`, which doesn't exist in this SDK version's `testutils` at all. |
| `reentrancy` | Compiles and runs cleanly. Uses the shared, configurable `ReentrantToken` mock (`keeper_registry::mocks`, issue #203) to randomize, per run, which payout path is targeted for reentrancy — `cancel_task`, `expire_task`, or `withdraw_rewards`, the only three entry points that transfer the reward token back out of the registry — and whether the re-entrant call fires before or after the token's own balance update. Asserts the re-entrant call never succeeds, generalizing the fixed-scenario CEI regressions in `test/cancel.rs` and `test/expire.rs` across all three payout paths at once instead of needing a bespoke target per function. |

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

## Seeding the corpus with boundary values

`fuzz/corpus/` is gitignored (see `.gitignore`'s comment — corpus is
regenerated locally and by CI, not committed, aside from crash
regressions), so a fresh checkout starts every target's corpus empty. That
means a fuzzer's early runs spend time rediscovering inputs the unit tests
already know are interesting — a proof at exactly `MAX_PROOF_LEN`, a
`fee_bps` at exactly `10_000` — before it starts exploring anything new.

`fuzz/src/seed.rs` generates a handful of hand-picked seeds for
`execute_task` from the contract's real boundary constants (`MAX_PROOF_LEN`,
the `10_000` bps fee cap), so they can't silently drift from the actual
values as the contract evolves. Regenerate before a local fuzzing session,
or after any of those constants change:

```bash
cd fuzz
cargo test --features arbitrary -- --ignored generate_execute_task_corpus --nocapture
```

A second ignored test, `generated_corpus_decodes_to_intended_boundaries`,
round-trips each generated seed through the real `arbitrary` crate and
asserts it decodes to the boundary value it's named for — this is the
closest stand-in available on stable Rust for `cargo fuzz run execute_task
-- -runs=0` (which needs the nightly ASan toolchain `cargo-fuzz` requires
and so isn't runnable in every environment) validating that the corpus
actually loads and parses.

Only `execute_task` is seeded. `register_task` and `smoke` don't currently
compile (see the "Target status" table above) — add seeding for them once
they're fixed.

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

**Wired up as of backlog 0066.** The `fuzz-pr` advisory job in `ci.yml` runs
every registered target for 60 seconds on any PR touching
`contracts/keeper-registry/` or `fuzz/`; `fuzz-nightly.yml` runs the same
targets for 15 minutes each on a daily schedule with a persistent corpus.
Neither blocks a merge — see [`docs/CI.md`](CI.md) for the full advisory-job
policy and how a crash is surfaced.

### Corpus growth tracking

Every job summary (`fuzz-pr` and `fuzz-nightly` alike) reports each target's
corpus file count and on-disk size in KiB, before and after the run. For
`fuzz-nightly` in particular — since its corpus persists across runs via the
`fuzz-corpus-*` cache — this is worth a periodic glance: a corpus that stops
growing across several consecutive nightly runs is a signal the fuzzer has
stopped finding new code paths, either because it has already covered
everything reachable or because something is wrong with the harness. This
doesn't page anyone; it's visibility, not alerting.

A short local run is still worth doing before opening a PR that touches
`execute_task` (the only currently-working target) or the shared
`invariants` module — CI's 60-second PR budget is enough to catch an
obvious regression, not to explore deeply:

```bash
cargo +nightly fuzz run execute_task -- -max_total_time=120
```

`cargo test -p keeper-registry` (which includes the `proptest!`-based
property tests) *is* run in ordinary CI today, same as any other unit test —
that part isn't optional or fuzzing-specific.

### Wave 2 check-in (backlog 0146)

Backlog 0146 asked for a check-in, once epic E03's full target list exists,
on whether the `fuzz-pr` budget (every registered target, 60 seconds each)
still holds, or whether a path-filter (only running targets whose
corresponding source file changed) is worth adding.

As of this check-in, `fuzz/fuzz_targets/` has four registered targets, not
the roughly a dozen the epic eventually expects, and per the "Target
status" table above, two of them (`register_task`, `smoke`) don't currently
compile and so exit immediately rather than spending their 60-second
budget. `fuzz-pr` therefore runs at most **two** targets for up to 60
seconds each (`execute_task`, `uninitialized_registry`) — around two
minutes of wall-clock time, on top of the toolchain/cache setup steps —
and only on PRs that touch `contracts/keeper-registry/` or `fuzz/` at all
(see the job's "Check for relevant changes" step in `ci.yml`).

That is not a noticeable per-PR wait, and a path-filter would add real
complexity (a diff-to-target mapping, and a fallback list of "shared"
files like `lib.rs` that must still trigger every target) for no current
benefit. Per this issue's own acceptance criteria, no change is made here.
This is worth revisiting once epic E03's remaining targets (`register_task`
and `smoke` fixed, plus the not-yet-landed targets tracked in backlog
0062, 0063, 0110, and 0134) actually land and are compiling — at that
point, re-measure `fuzz-pr`'s wall-clock time with the fuller target list
before deciding whether path-filtering is worth adding.
## Epic E03 retrospective: invariant coverage map

Epic E03 is fuzzing and property testing. This section is its closing
summary — the coverage map issue 0142 asks for, so a contributor can see
at a glance which invariant is backed by which test or fuzz target
instead of cross-referencing the individual issues above.

| Invariant | Property test | Fuzz target | Status |
|---|---|---|---|
| I-1 — Solvency | `property_i1_solvency_holds_across_random_task_outcomes` | `execute_task` (restricted to the executed task's contribution) | Covered |
| I-2 — Escrow recoverability | `property_i2_lapsed_claim_is_always_expirable` | — | Covered by property test only |
| I-3 — Single payout | `property_i3_single_payout_not_doubled` | — | Covered by property test only |
| I-4 — Fee bounding | `property_i4_fee_bounded_across_arbitrary_inputs` | `execute_task` | Covered |
| I-5 — Escrow isolation | `property_i5_sweep_fees_isolated_from_escrow_and_keeper_balances` | — | Covered by property test only |
| I-6 — Withdrawal liveness | `property_i6_withdrawal_live_while_paused` | — | Covered by property test only |
| I-7 — Monotonic task ids | `property_i7_task_ids_strictly_increasing` | — | Covered by property test only |

All seven live in `contracts/keeper-registry/src/test/property.rs` and
call the matching `assert_*` function in `invariants.rs`, per the "Using
the shared invariant module" section above. `register_task` and `smoke`
not compiling (see the target-status table) means I-2, I-3, I-5, I-6 and
I-7 currently have no fuzz-level coverage, only property-test coverage —
closing that gap is real, scoped follow-up work, not something this
retrospective can claim as done.

**Two invariants exist in code ahead of `docs/ARCHITECTURE.md`.** The
property suite already has `property_i8_ttl_always_covers_deadline_or_registration_is_rejected`
and `property_i9_instance_ttl_never_lapses_under_bounded_gap_traffic`
(issues 0120 and 0122), but `docs/ARCHITECTURE.md`'s money-invariants list
still only documents `I-1` through `I-7` — these two were never promoted
to that list. This is a known gap this retrospective surfaces rather than
silently working around: whoever picks up backlog issue 0132 (which plans
to add a verifier-trust-boundary invariant numbered `I-8`) needs to
renumber it to `I-10` (or docs/ARCHITECTURE.md needs its own pass to
promote the TTL pair to `I-8`/`I-9` first), since the number is already
in active use in the test suite. Neither has happened yet as of this
writing.

**Mutation testing (issue 0135) has not been run yet.** The exploration
issue is still open — no mutation-testing tool has been tried against
`contracts/keeper-registry`, and no CI job or finding exists in this
repository to summarize. That is itself the honest status to record here:
line/branch coverage (via `cargo-llvm-cov`, backlog 0030) tells you what
ran, not whether the assertions would catch a mutated bug, and that
sharper question remains unanswered pending 0135.

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

- **A committed crash corpus** under `fuzz/corpus/*/regressions/` — none
  exists yet, since no crash has been found and minimized.
