# Contribution Backlog

This directory is the source of truth for the project's issue backlog. Every
issue is written here first, reviewed as a normal file diff, and then published
to GitHub Issues with `./push.sh`.

Keeping issues in the repository means the roadmap is version-controlled,
diffable, and reviewable — the same standard we hold code to.

---

## How this is organised

Issues are numbered `0001`–`0600` in **delivery order**, not by topic. A lower
number means the work is ready to start now; a higher number means it depends on
something earlier. Each issue file declares which epic it belongs to, so you can
still read the backlog thematically using the [epic index](#epic-index) below.

```
.github/backlog/
├── README.md            ← you are here
├── push.sh              ← publishes a range of issues to GitHub
└── issues/
    ├── 0001-*.md
    ├── 0002-*.md
    └── …
```

Each issue file has YAML front matter followed by the issue body in Markdown:

```yaml
---
title: "fix(registry): short imperative description"
labels: [contract, bug, intermediate]
epic: E01
wave: 1
depends_on: []
---
```

The front matter is metadata for the publishing script. Everything below it is
what appears on GitHub verbatim.

---

## Waves

The backlog is released to GitHub in waves so contributors are never staring at
600 open issues at once, and so later issues can be revised in light of what the
earlier work actually produced.

| Wave | Issues | Theme | Status |
|------|--------|-------|--------|
| 1 | 0001–0050 | Correctness, spec alignment, and test gaps in the shipped MVP; keeper-bot fixes; contributor tooling | **Published** |
| 2 | 0051–0150 | Execution verifier, batch operations, gas work, fuzzing and invariant testing | Planned |
| 3 | 0151–0300 | TypeScript SDK, Rust SDK, event indexer, keeper bot v2 | Planned |
| 4 | 0301–0450 | Staking, slashing, reputation, treasury, governance | Planned |
| 5 | 0451–0600 | Dashboard, CLI, observability, audit readiness, docs and ecosystem examples | Planned |

"Planned" means the epic scope and issue count are fixed but the issue files
are not written yet. Only wave 1 exists on disk today. Waves are written one at
a time, deliberately: issues 0051 onward depend on decisions that wave 1 will
settle — the TTL model, the proof-in-event shape, the branching workflow — and
writing them before those land would produce issues that specify the wrong
thing.

---

## Picking something up

1. Find an issue labelled `good-first-issue` if this is your first PR here.
2. **Comment on the GitHub issue** to claim it before you start, so two people
   don't do the same work.
3. Read [CONTRIBUTING.md](../../CONTRIBUTING.md) — branching, commit format, and
   the PR checklist are all there.
4. Branch from `develop`, not `main`.

Every issue states its own acceptance criteria. If an acceptance criterion turns
out to be wrong once you are in the code, say so on the issue — a corrected
issue is a better contribution than a PR that satisfies a bad spec.

---

## Difficulty labels

| Label | What it means |
|-------|---------------|
| `good-first-issue` | Self-contained. One or two files. No design decisions required — the issue tells you what to do. |
| `intermediate` | Assumes you have read the contract and understand the task lifecycle. May touch several files or require a judgement call. |
| `advanced` | Design-heavy, security-sensitive, or spans multiple components. Discuss your approach on the issue before writing code. |

---

## Epic index

| Epic | Title | Issues | Scope |
|------|-------|--------|-------|
| E01 | Contract Core Hardening | 36 | Correctness, error handling, storage TTL, event completeness in `keeper-registry` |
| E02 | Contract Test Suite | 42 | Unit, boundary, and conservation tests; coverage tooling |
| E03 | Fuzzing & Invariant Testing | 20 | `cargo-fuzz`, property tests, stateful model checking |
| E04 | On-chain Execution Verifier | 26 | The `IKeeperVerifier` interface and registry-side verification callback |
| E05 | Batch Operations & Gas | 22 | Batch registration, storage layout tuning, WASM size and CPU budget work |
| E06 | Keeper Staking & Slashing | 30 | Stake escrow, slash conditions, unbonding, dispute windows |
| E07 | Keeper Reputation | 20 | On-chain scoring, priority queues, decay |
| E08 | Treasury & Fee Distribution | 22 | Treasury contract, automated fee routing, revenue accounting |
| E09 | Governance & $KPRS | 30 | Token contract, proposals, voting, timelock, parameter control |
| E10 | Task Conditions & checkUpkeep | 22 | On-chain predicates evaluated before a claim is allowed |
| E11 | Oracle Integration | 16 | Reflector/Band-driven task conditions |
| E12 | TypeScript SDK | 38 | Typed client, transaction builders, React hooks, docs |
| E13 | Rust SDK | 22 | Typed client crate for contract-to-contract and native integrations |
| E14 | Event Indexer | 32 | Ingest, schema, API, backfill, reorg handling |
| E15 | Keeper Bot v2 | 38 | State persistence, profitability, concurrency, pluggable executors |
| E16 | CLI Tooling | 24 | `skn` CLI for deploying, registering, and inspecting tasks |
| E17 | Web Dashboard | 32 | Task explorer, keeper leaderboard, protocol stats |
| E18 | Observability & Ops | 20 | Metrics, tracing, alerting, runbooks |
| E19 | Security & Audit Readiness | 28 | Threat model, invariants doc, audit prep, disclosure process |
| E20 | Documentation & DevRel | 34 | Guides, tutorials, API reference, integration walkthroughs |
| E21 | CI/CD & Developer Experience | 26 | Pipelines, release automation, local tooling, templates |
| E22 | Examples & Ecosystem Integrations | 20 | Reference dApps that register tasks against the registry |
| | **Total** | **600** | |

---

## Publishing

`push.sh` reads the issue files, converts the front matter into `gh issue create`
arguments, and publishes a range. It is idempotent by title: an issue whose title
already exists on the repository is skipped rather than duplicated.

```bash
# Dry run — print what would be created, change nothing
./.github/backlog/push.sh --from 1 --to 50 --dry-run

# Actually publish
./.github/backlog/push.sh --from 1 --to 50
```

Issue numbers in this directory are **backlog** numbers. They are deliberately
never written into the issue title or body, because GitHub assigns its own issue
numbers on publish and the two must not be confused.
