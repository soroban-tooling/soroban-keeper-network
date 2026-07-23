---
title: "chore(make): add a make ci target that runs exactly what CI requires"
labels: [tooling, good-first-issue]
epic: E21
wave: 1
depends_on: []
---

## Summary

There is no single command that reproduces the blocking CI checks. Contributors run some subset of `make fmt-check`, `make test`, and `make lint` from memory, and the Makefile's commands do not match what the pipeline actually runs.

## Current state

The Makefile offers individual targets:

```makefile
test:       cargo test -p keeper-registry
fmt-check:  cargo fmt --all -- --check
lint:       cargo clippy --all-targets -- -D warnings
wasm:       cargo build -p keeper-registry --target wasm32-unknown-unknown --release
```

CI runs:

```yaml
- cargo fmt --all -- --check
- cargo test --workspace --locked
- cargo build --locked --release --target wasm32-unknown-unknown --package keeper-registry
```

Three mismatches, each capable of producing a local pass and a CI failure:

**`--locked` is missing locally.** CI builds with the committed `Cargo.lock`. Locally, cargo may silently update it. A contributor whose local resolution differs sees green locally and a lockfile-drift failure in CI.

**`-p keeper-registry` versus `--workspace`.** Equivalent today with one member, but they diverge the moment a second crate is added — which the roadmap plans for.

**`make lint` is stricter than CI.** It denies all warnings; CI treats clippy as advisory. A contributor following the Makefile can be blocked locally by something CI would merely report.

The deeper problem is that nobody knows which commands constitute "ready to push". The PR checklist names four, CONTRIBUTING names three slightly different ones, and neither matches the Makefile.

## Expected behaviour

`make ci` runs exactly the blocking CI checks, with the same flags, and its success means CI will pass.

## Suggested approach

```makefile
ci: fmt-check test wasm ## Run exactly the checks that block a PR

check: ci lint ## Run the blocking checks plus the advisory linters
```

and correct the underlying targets to match the pipeline:

```makefile
test: ## Run the test suite (as CI does)
	cargo test --workspace --locked

wasm: ## Build the release WASM (as CI does)
	cargo build --locked --release --target wasm32-unknown-unknown --package keeper-registry
```

Keep `lint` available but out of `ci`, since CI does not block on it. Consider renaming it to signal that — `lint-strict`, or leaving a comment on the target explaining that it is deliberately stricter than the pipeline.

Two things worth doing beyond the mechanical change:

**Make drift detectable.** The Makefile and the workflow will diverge again unless something notices. The cheapest defence is a comment in both files pointing at the other, with a line in `docs/CI.md` stating that they must be kept in step. A CI step that greps the workflow for the commands `make ci` runs is possible but probably over-engineered for three commands — mention the option in the PR and let the reviewer decide.

**Check `make help` still works.** It parses `## ` comments out of target lines, so any new target needs one to appear in the listing.

## Acceptance criteria

- [ ] `make ci` runs the format check, the test suite, and the WASM build with CI's exact flags.
- [ ] `make test` and `make wasm` use `--locked` and match the workflow.
- [ ] `make lint` stays available and its stricter-than-CI status is documented on the target.
- [ ] Every target has a `## ` description and appears in `make help`.
- [ ] CONTRIBUTING's pre-PR instructions point at `make ci` instead of listing commands.
- [ ] The PR checklist references `make ci`.
- [ ] A comment in both the Makefile and `ci.yml` notes that the two must stay in step.

## Files

- `Makefile`
- `CONTRIBUTING.md`
- `.github/PULL_REQUEST_TEMPLATE.md`
- `.github/workflows/ci.yml` — comment only

## Getting started

Good first issue. Verify by running `make ci` on a clean checkout and confirming it passes, then deliberately introducing a formatting error and confirming it fails.
