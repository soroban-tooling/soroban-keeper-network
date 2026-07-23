---
title: "chore(ci): add cargo-llvm-cov coverage reporting as an advisory CI job"
labels: [tooling, testing, intermediate]
epic: E21
wave: 1
depends_on: []
---

## Summary

There is no coverage measurement, so decisions about where tests are missing are being made by reading the source. A coverage report would target that work directly.

## Expected behaviour

`cargo llvm-cov` runs on every PR as an advisory job, writes a summary to the job summary, and the project documents how to run it locally.

## Why advisory, and why no threshold

CI policy for this repository is that only formatting, tests, and the WASM build block a merge. Coverage should follow that rule, for a specific reason beyond consistency: a hard coverage gate on a contract this small produces bad incentives. A three-line PR that adds a guard clause can drop total coverage below a threshold and get blocked, and the fastest way to unblock it is a test that asserts nothing meaningful. Reviewers judging a coverage *delta* is more useful than CI judging an absolute number.

Report the number, do not gate on it. If the project later wants a floor, that should be its own discussion with data from several months of reports.

## Suggested approach

Local first — the tool is only useful if contributors can run what CI runs:

```bash
cargo install cargo-llvm-cov --locked
cargo llvm-cov --workspace --html    # browsable report
cargo llvm-cov --workspace --summary-only
```

Add a `make coverage` target alongside the existing `make test` and `make lint`.

Then a CI job following the advisory pattern already used by `clippy` and `audit` in `.github/workflows/ci.yml`:

```yaml
  coverage:
    name: Coverage (advisory)
    runs-on: ubuntu-latest
    continue-on-error: true
    steps:
      - uses: actions/checkout@v4
      - uses: dtolnay/rust-toolchain@stable
        with:
          components: llvm-tools-preview
      - uses: taiki-e/install-action@cargo-llvm-cov
      - name: Measure coverage
        run: cargo llvm-cov --workspace --summary-only | tee cov.txt
      - name: Publish summary
        run: |
          {
            echo "### Coverage"
            echo
            echo '```'
            cat cov.txt
            echo '```'
          } >> "$GITHUB_STEP_SUMMARY"
```

Two things to work out while implementing:

**What to exclude.** Test modules and generated contract bindings inflate the number without meaning anything. Configure exclusions in `Cargo.toml` or via `--ignore-filename-regex` and document what was excluded and why — an unexplained exclusion list is how coverage numbers become fiction.

**Whether it works at all here.** `keeper-registry` is `crate-type = ["cdylib"]` and the tests run against the Soroban test environment. Confirm `cargo llvm-cov` instruments this correctly and produces plausible numbers before wiring up CI. If it does not, that finding is itself a valuable result — report it on the issue rather than shipping a job that reports a meaningless figure.

Do not add a coverage badge to the README in this PR. Badges imply a stable, trusted number, and that should wait until the report has been observed to be accurate over several PRs.

## Acceptance criteria

- [ ] `cargo llvm-cov` runs locally and produces a plausible report for this crate.
- [ ] A `make coverage` target exists.
- [ ] An advisory CI job publishes the summary to the job summary.
- [ ] The job cannot fail the PR.
- [ ] Exclusions are documented with reasoning.
- [ ] CONTRIBUTING mentions how to run coverage locally.
- [ ] No coverage threshold or gate is introduced.

## Files

- `.github/workflows/ci.yml`
- `Makefile`
- `CONTRIBUTING.md`

## References

- [cargo-llvm-cov](https://github.com/taiki-e/cargo-llvm-cov)
