# Auditor handoff package

This is the day-one index for an independent review. It intentionally
distinguishes source documentation from evidence that a control operated.

## Pinned review baseline

- Upstream source baseline:
  [`22fc72304c950f539355330149dc30aef0b22a71`](https://github.com/soroban-tooling/soroban-keeper-network/tree/22fc72304c950f539355330149dc30aef0b22a71)
- Required documentation parent (mainnet-readiness delivery):
  `b2b8dc7ffcc20cd5d5bdd125851ef3f5da9c81b4`
- Audit-package overlay: the pull-request head containing this file. Record its
  immutable merge commit here before handing a release candidate to auditors.

Auditors should review the final immutable commit, not a moving branch. The
two hashes above explain the source and stacked dependency used to assemble
this package; they are not substitutes for the final review hash.

## Review scope

In scope are the production contracts under `contracts/` (keeper registry,
treasury, governance/token, conditions, verifiers, and oracle adapter), their
shared SDKs and event encodings, the keeper bots, indexer ingestion/API/store,
dashboard transaction boundary, deployment/release configuration, migrations,
and security-critical CI/fuzz tooling. Tests, mocks, examples, and documents
are evidence inputs but are not deployed production code unless a release
explicitly packages them.

Out of scope are third-party RPC/oracle implementations, browser extensions,
wallet custody, cloud/provider control planes, and operating-system security.
Their integration and configuration boundaries remain in scope. The auditor
should record the exact dependency versions and deployed addresses assumed by
the report.

## Document index

| Question | Primary document | Baseline |
|---|---|---|
| What code and components are in scope? | [`AUDIT_SCOPE.md`](AUDIT_SCOPE.md) | `22fc7230` |
| What can go wrong and what remains accepted? | [`THREAT_MODEL.md`](THREAT_MODEL.md) | PR head |
| Who can call each privileged surface? | [`ACCESS_CONTROL_MATRIX.md`](ACCESS_CONTROL_MATRIX.md) | PR head |
| Which safety properties must hold? | [`ARCHITECTURE.md`](ARCHITECTURE.md), [`STAKING_DESIGN.md`](STAKING_DESIGN.md), [`TREASURY_DESIGN.md`](TREASURY_DESIGN.md), [`GOVERNANCE_DESIGN.md`](GOVERNANCE_DESIGN.md) | `22fc7230` |
| What did component security reviews find? | [`INDEXER_SECURITY_REVIEW.md`](INDEXER_SECURITY_REVIEW.md), [`STAKING_SECURITY_REVIEW.md`](STAKING_SECURITY_REVIEW.md), [`TREASURY_SECURITY_REVIEW.md`](TREASURY_SECURITY_REVIEW.md), [`GOVERNANCE_SECURITY_REVIEW.md`](GOVERNANCE_SECURITY_REVIEW.md), [`KEEPER_BOT_V2_SECURITY_REVIEW.md`](KEEPER_BOT_V2_SECURITY_REVIEW.md) | Baseline plus PR head for indexer |
| What does fuzzing reach and miss? | [`FUZZING.md`](FUZZING.md) | PR head |
| How is the system built and deployed? | [`CI.md`](CI.md), [`DEPLOYING.md`](DEPLOYING.md), [`INDEXER_DEPLOYMENT.md`](INDEXER_DEPLOYMENT.md) | `22fc7230` |
| Is mainnet approved? | [`MAINNET_READINESS.md`](MAINNET_READINESS.md) | `b2b8dc7f`; currently `NO-GO` |
| How are vulnerabilities reported? | [`../SECURITY.md`](../SECURITY.md) | `22fc7230` |

## Build and test from a clean checkout

Use a disposable checkout of the exact review commit. Do not reuse build
artifacts or environment files from an operator machine.

```bash
git clone https://github.com/soroban-tooling/soroban-keeper-network.git
cd soroban-keeper-network
git checkout --detach <immutable-review-commit>
git status --porcelain
rustup show active-toolchain
cargo fmt --all -- --check
cargo test --workspace --locked
cargo build --locked --release --target wasm32-unknown-unknown --package keeper-registry
cargo test --locked --package keeper-indexer
cd apps/dashboard && npm ci && npm run build && npm test
```

For fuzz coverage, install nightly plus `llvm-tools-preview`, restore the
review corpus, and run:

```bash
./scripts/run-fuzz-targets.sh 60 "Audit smoke fuzz"
./scripts/generate-fuzz-coverage.sh fuzz/coverage-report
```

The runner expects `GITHUB_STEP_SUMMARY`; for a local run set it to a temporary
file. Do not treat an advisory fuzz build failure as a passing target: inspect
`fuzz/coverage-report/summary.md` and each target log.

## Verification record

The pull request must state the exact commands that were run and distinguish:

- checks passed for this change;
- pre-existing baseline failures that were observed but not repaired;
- checks not run because required infrastructure was unavailable;
- remote CI state, which is not implied by local results.

No failed unrelated CI check should be repaired as part of this handoff.

## Known issues and release blockers

1. The current complete system has no committed independent audit report.
2. `MAINNET_READINESS.md` remains `NO-GO` until each checkbox has immutable
   evidence and approval.
3. Accepted component risks are consolidated in `THREAT_MODEL.md`; source
   documents remain authoritative for detailed findings.
4. Fuzz targets and entry points without successful mutation coverage are
   listed in `FUZZING.md`; coverage artifacts are advisory evidence, not a
   security proof.
5. Indexer process-local limits require production proxy/fleet configuration,
   load testing, metrics, and alerting.

## Auditor deliverables

Record the immutable review commit, toolchain versions, command output, threat
model changes, findings with severity and affected invariant, remediation
commit, retest result, and explicit disposition of every residual risk. Link
the final signed report from this page and `MAINNET_READINESS.md` before any
mainnet approval.
