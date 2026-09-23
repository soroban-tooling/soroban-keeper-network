# Keeper Bot v2 — Scope, Architecture, and Design Specification

## Overview

This document specifies the architecture, operational model, and design decisions for **Keeper Bot v2** (`examples/keeper-bot-v2`), following the open-source backlog epic **E15** (issues `0250`–`0287`) and addressing GitHub issues **#404**, **#407**, **#412**, and **#413**.

While the original keeper bot (`examples/keeper-bot/index.js`) is intentionally kept beginner-friendly, monolithic, and sequential per `CONTRIBUTING.md`, **Keeper Bot v2** is engineered for competitive production operators requiring high throughput, bounded resource budgets, race-resilient execution, and actionable observability.

---

## 1. Architectural Decisions & Scope

### 1.1 Package Location and Relationship to v1

* **Decision**: Keeper Bot v2 lives in a dedicated package under `examples/keeper-bot-v2/`.
* **Rationale**: `CONTRIBUTING.md` mandates that `examples/keeper-bot` remains an accessible, beginner-friendly reference implementation without heavy infrastructure requirements. Adding persistent databases, concurrency workers, fee market tracking, and complex state management to v1 would create high friction for developers learning the Soroban Keeper Network for the first time. Isolating v2 in `examples/keeper-bot-v2` preserves v1 as a pedagogical baseline while giving operators a modular, battle-tested foundation.
* **Language & Runtime**: Node.js (>=18.0.0), JavaScript with a clean modular structure under `src/`. Standard ESM dynamic import (`await import("@soroban-keeper-network/sdk")`) is retained to seamlessly bridge with the pure-ESM `@soroban-keeper-network/sdk`.

### 1.2 Modular Directory Layout

```
examples/keeper-bot-v2/
├── package.json
├── README.md
├── eslint.config.js
├── src/
│   ├── index.js          # Entrypoint and lifecycle coordination
│   ├── config.js         # Strict environment validation (v1 + v2 parameters)
│   ├── state.js          # In-memory / persistent task state registry
│   ├── profitability.js  # Gas cost and net profit estimation
│   ├── prioritization.js # Net-profit-ranked candidate queuing
│   ├── loop.js           # Concurrent round loop with hard spend ceiling
│   ├── metrics.js        # Prometheus-compatible operational counters
│   └── executors.js      # Pluggable task execution engine
├── test/
│   ├── spend_ceiling.test.js # Hard spend ceiling verification (Issue #407)
│   └── competition.test.js   # Multi-keeper competition harness (Issue #404)
└── benchmark/
    ├── benchmark.js      # Latency & throughput benchmark against v1 (Issue #413)
    └── REPORT.md         # Committed benchmark evaluation report
```

### 1.3 State Persistence Model

* **Problem**: v1 maintains no state across restarts or rounds, causing potential duplicate processing or lack of visibility into in-flight claims.
* **Solution**: `src/state.js` maintains task lifecycle states:
  * `DISCOVERED`: Task event picked up from ledger events or indexer.
  * `EVALUATING`: Profitability and eligibility checks in progress.
  * `CLAIMING` / `CLAIMED`: Task locked on-chain by this keeper.
  * `EXECUTING`: Off-chain computation in flight.
  * `EXECUTED`: Final `execute_task` completed on-chain.
  * `SKIPPED`: Task intentionally bypassed (with structured reason).
* Tasks marked `CLAIMING` or `CLAIMED` are locked within the local process, preventing concurrent internal workers from racing on the same task ID.

### 1.4 Concurrency Model

* **Worker Pool**: Each round evaluates candidate tasks concurrently up to a configurable limit (`maxConcurrency`, default: 4, configurable via `MAX_CONCURRENCY`).
* **Intra-Process Isolation**: Worker tasks acquire exclusive task reservations via `TaskStateRegistry`. Two workers in the same keeper process will never attempt competing claims for the same task ID.

### 1.5 Task Prioritization

* **Ranking by Expected Net Profit**: Candidate tasks discovered in a round are evaluated by expected net reward (`reward - estimatedGasFees`). Tasks are sorted descending by net profit.
* High-value tasks are claimed first, preventing lower-reward tasks from consuming available concurrency slots or budget allocations.

---

## 2. Hard Ceiling on Per-Round Resource Spend (Issue #407)

### 2.1 Problem Statement
Concurrency and prioritization increase the volume of transactions a single keeper round can attempt. Without an explicit ceiling, candidate bursts (such as batch task registrations) or volatile network fee spikes could submit far more transactions than an operator intended, eroding margins or causing runaway fee spend.

### 2.2 Mechanism & Invariant Guarantees
1. **Configurable Ceiling**: Configured via `MAX_ROUND_SPEND_STROOPS` (default: 5,000,000 stroops = 0.5 XLM).
2. **Independent Backstop**: The spend ceiling is evaluated independently of task-level profitability. A task may have high expected profit, but if the round's cumulative spend has reached `MAX_ROUND_SPEND_STROOPS`, no further transactions (claims or executions) are dispatched in that round.
3. **Distinct Logging**: When the ceiling is reached, the keeper emits a distinct log:
   `[RESOURCE CEILING] Hard round spend ceiling reached: spent ${roundSpend} stroops (ceiling: ${maxSpend} stroops). Halting further submissions this round.`
4. **Metrics Tracking**: Increments `spend_ceiling_reached` in `src/metrics.js` and records skipped candidates under the structured skip reason `"spend_ceiling_reached"`.

---

## 3. Multi-Keeper Competition & Lost-Race Handling (Issue #404)

### 3.1 Problem Statement
In production, multiple independent keeper bots compete to claim the same profitable tasks. In v1, an on-chain rejection due to a lost race (`TaskAlreadyClaimed`) was logged as an error and added to `summary.errors`, misrepresenting normal competitive dynamics as system failures.

### 3.2 Expected Behavior
1. **Success-with-Skip**: A lost claim race is recognized via `isLostClaimRaceError(err)` (matching error code 2 / `TaskAlreadyClaimed` / "already claimed" / "already locked" / "TaskNotPending"). It is treated as normal competition (`success-with-skip`), NOT logged as an error, and NOT appended to `summary.errors`.
2. **Round Continuation**: The bot logs `[COMPETITION] Task ${taskId} already claimed by competitor; treating as normal skip.` and immediately proceeds to evaluate remaining candidates in the queue.
3. **Metrics Distinction**: `src/metrics.js` records lost claim races under a dedicated counter `metrics.recordSkip("lost_claim_race", taskId)`, keeping it cleanly separated from `unprofitable`, `unsupported_executor`, or RPC errors.

---

## 4. Deferral of Verifier-Aware Proof Generation (Issue #412)

### 4.1 Context and Problem Statement
Earlier backlog issues (`0090`, `0091`, and issues in the `0102`–`0140` range) proposed bot support for tasks gated by an on-chain verifier contract. Those design artifacts (`docs/VERIFIER_DESIGN.md`, `docs/VERIFIERS.md`) anticipated that keeper bots would synthesize zero-knowledge or external cryptographic proofs before executing tasks.

However, an audit of the deployed `KeeperRegistry` contract (`contracts/keeper-registry/src/`) reveals that **the contract-side verifier infrastructure does not exist**:
1. **Missing `Task.verifier` Field**: The `Task` struct on-chain has fields `id`, `owner`, `task_type`, `status`, `reward`, `calldata`, `deadline`, and `unlock_at`. It has **no** `verifier` field.
2. **Missing Entry Points**: The contract does **not** expose `update_verifier`, `set_verifier`, or `verify`.
3. **Missing Cross-Contract Invocation**: `execute_task` validates keeper locks, status, and caller authorization, but makes **no** cross-contract call to an external verifier.
4. **Placeholder Error Variant**: Only a placeholder error variant `IncompatibleVerifierInterface = 6` exists in `contracts/keeper-registry/src/errors.rs`, with no reachable code path inside the contract that ever constructs or returns it.

### 4.2 Explicit Deferral Policy
In accordance with Issue **#412**:
* **Explicit Dependency**: Verifier-aware proof generation in the bot is strictly blocked on the contract-side feature landing.
* **No Speculative Code**: **No bot code is written against an unimplemented verifier interface in keeper-bot-v2.** Building bot-side logic against a non-existent on-chain interface creates untestable dead code and misleads operators into believing the capability is operational.
* **Supersession Plan**: When the contract-side verifier capabilities are formally introduced (adding `Task.verifier`, registry verification entry points, and cross-contract validation in `execute_task`), this placeholder section will be superseded by active proof-generation implementations referencing the specific issue numbers assigned to that epic.

---

## 5. Performance Benchmarking Methodology (Issue #413)

### 5.1 Benchmark Harness
The benchmark harness in `examples/keeper-bot-v2/benchmark/` tests Keeper Bot v1 (sequential) against Keeper Bot v2 (concurrent + prioritized) under strictly identical simulated conditions:
* **Workload**: 20 candidate tasks with heterogeneous reward distributions (10,000 stroops to 5,000,000 stroops).
* **Simulated Network Latency**: Controlled 25ms delay per RPC simulation, claim, and execution call.
* **Contention**: 30% phantom competitor claim rate simulating real-world race conditions.
* **Metrics Recorded**:
  * Round Latency (ms)
  * Tasks Won / Executed
  * Net Profit Realized (stroops)
  * Error Counts & Lost Race Classification

The committed report is preserved in `examples/keeper-bot-v2/benchmark/REPORT.md`.
