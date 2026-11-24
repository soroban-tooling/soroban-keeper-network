# Soroban Keeper Network Examples Catalog

A curated collection of runnable examples, reference implementations, and automated bots demonstrating how to build, deploy, finance, and operate tasks on the Soroban Keeper Network.

---

## Difficulty Map

```text
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                                 DIFFICULTY SPECTRUM                                    │
│                                                                                        │
│   🟢 Beginner                🟡 Intermediate                 🔴 Advanced              │
│   ─────────────────────      ────────────────────────────    ───────────────────────── │
│   • local-quickstart         • batch-register                • keeper-bot-v2           │
│   • keeper-bot               • ttl-extension                 • limit-order             │
│                              • recurring-payment                                       │
│                              • vesting-release                                         │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

| Example Directory | Difficulty | Target Audience | Key Concepts Demonstrated | Prerequisites |
| :--- | :---: | :---: | :--- | :--- |
| [`local-quickstart`](./local-quickstart/) | 🟢 Beginner | Developers, Evaluators | One-command local network deployment, demo task execution | Docker, Node.js 18+ |
| [`keeper-bot`](./keeper-bot/) | 🟢 Beginner | New Keeper Operators | Single-file polling bot, transaction simulation, claiming | Node.js 18+, Funded Stellar account |
| [`batch-register`](./batch-register/) | 🟡 Intermediate | dApp Owners, Protocols | Bulk task registration from CSV/JSON payloads | Node.js 18+, Owner wallet with XLM |
| [`ttl-extension`](./ttl-extension/) | 🟡 Intermediate | Smart Contract Authors | State archival defense, persistent storage TTL renewal, owner cost model | Node.js 18+, Soroban CLI |
| [`recurring-payment`](./recurring-payment/) | 🟡 Intermediate | SaaS, Subscription dApps | Subscription billing, double-payment prevention, automated next-task chaining | Node.js 18+, Token contract |
| [`vesting-release`](./vesting-release/) | 🟡 Intermediate | DAOs, Token Teams | Autonomous keeper-triggered tranche releases, cliff gating, tranche boundaries | Node.js 18+, Token contract |
| [`keeper-bot-v2`](./keeper-bot-v2/) | 🔴 Advanced | Professional Operators | High-performance TypeScript bot, worker concurrency, Prometheus metrics, Postgres | Node.js 20+, Docker, PostgreSQL |
| [`limit-order`](./limit-order/) | 🔴 Advanced | DeFi Protocols, Traders | On-chain price-threshold condition gating (epic E11), DEX swap slippage protection | Node.js 18+, Reflector Oracle, DEX Router |

---

## Detailed Directory Breakdown

### 1. [`local-quickstart`](./local-quickstart/)
- **Difficulty**: 🟢 Beginner
- **Audience**: Anyone exploring the network for the first time.
- **Summary**: A single script that brings up a local standalone `stellar/quickstart` container, deploys the Keeper Registry and a reward token contract, registers a demo task, and launches a keeper bot that automatically claims and executes it.
- **Run command**:
  ```bash
  cd examples/local-quickstart && npm start
  ```

---

### 2. [`keeper-bot`](./keeper-bot/)
- **Difficulty**: 🟢 Beginner
- **Audience**: Independent bot operators seeking a readable, single-file reference implementation.
- **Summary**: Demonstrates the fundamentals of running a keeper bot: querying pending tasks via Soroban RPC, checking deadlines, simulating transactions, claiming tasks, and withdrawing accrued fees.
- **Run command**:
  ```bash
  cd examples/keeper-bot && npm start
  ```

---

### 3. [`batch-register`](./batch-register/)
- **Difficulty**: 🟡 Intermediate
- **Audience**: Protocol operations teams needing to register dozens or hundreds of tasks simultaneously.
- **Summary**: Reads CSV or JSON task manifests, validates arguments, performs batch balance checks, and registers tasks across multiple transactions with progress reporting and retry handling.
- **Run command**:
  ```bash
  cd examples/batch-register && node index.js --file tasks.example.json
  ```

---

### 4. [`ttl-extension`](./ttl-extension/)
- **Difficulty**: 🟡 Intermediate
- **Audience**: Soroban dApp developers maintaining persistent storage.
- **Summary**: Shows how to prevent contract state archival by registering a recurring keeper task that calls `extend_ttl` whenever remaining storage lifetime drops below a safety threshold. Features a comprehensive owner cost model comparing keeper upkeep against archival restoration penalties.
- **Run command**:
  ```bash
  cd examples/ttl-extension && npm test
  ```

---

### 5. [`recurring-payment`](./recurring-payment/)
- **Difficulty**: 🟡 Intermediate
- **Audience**: Subscription billing, SaaS, and payroll protocols.
- **Summary**: A recurring subscription contract where keepers execute periodic payments. Strictly guarantees on-chain that double payments within the same billing period are refused, and includes an automated chaining script that schedules each subsequent period's task upon execution.
- **Run command**:
  ```bash
  cd examples/recurring-payment && npm test
  ```

---

### 6. [`vesting-release`](./vesting-release/)
- **Difficulty**: 🟡 Intermediate
- **Audience**: Token foundations, DAOs, and protocol treasuries.
- **Summary**: Autonomous token vesting where keepers trigger cliff and tranche releases so beneficiaries don't need to manually claim. The smart contract strictly refuses premature releases before the cliff date or between tranche dates.
- **Run command**:
  ```bash
  cd examples/vesting-release && npm test
  ```

---

### 7. [`keeper-bot-v2`](./keeper-bot-v2/)
- **Difficulty**: 🔴 Advanced
- **Audience**: Commercial node runners and high-volume operators competing for execution rewards.
- **Summary**: Production-ready bot architecture built in TypeScript. Features Postgres-backed state tracking, worker pools for concurrent simulation and submission, liveness/readiness health probes, and Prometheus telemetry.
- **Run command**:
  ```bash
  cd examples/keeper-bot-v2 && npm start
  ```

---

### 8. [`limit-order`](./limit-order/)
- **Difficulty**: 🔴 Advanced
- **Audience**: DeFi engineers, DEX builders, and algorithmic traders.
- **Summary**: Combines an on-chain `PriceThresholdCondition` contract (which reads the Reflector Oracle price feed) with a DEX swap execution. Verifies that keepers cannot spoof off-chain prices and strictly enforces slippage protection (`min_amount_out`) so unfavorable trades revert safely.
- **Run command**:
  ```bash
  cd examples/limit-order && npm test
  ```

---

## Suggested Learning Path

1. **New to Soroban Keepers?** Start with [`local-quickstart`](./local-quickstart/) to see the entire lifecycle execute in under 60 seconds.
2. **Want to Earn Keeper Rewards?** Study [`keeper-bot`](./keeper-bot/) for the basics, then deploy [`keeper-bot-v2`](./keeper-bot-v2/) for production reliability.
3. **Automating a dApp?** Explore [`ttl-extension`](./ttl-extension/) for storage upkeep, [`recurring-payment`](./recurring-payment/) for billing, or [`limit-order`](./limit-order/) for conditional DEX trading.

---

## Additional SDK Examples

- [`rust-sdk/examples/liquidation-keeper`](../rust-sdk/examples/liquidation-keeper) — A minimal liquidation keeper in Rust.
- [`rust-sdk/examples/calling-contract`](../rust-sdk/examples/calling-contract) — Calling the registry from your own Rust contract.
- [`packages/sdk-ts/examples`](../packages/sdk-ts/examples) — Node signing, wallet signing, and a React app in TypeScript.

## Epic E22 retrospective

Written 2026-11-19 from the state of the repository and the open pull
requests on that date. The epic's work items are the backlog files
`0553` to `0572` under [`.github/backlog/issues`](../.github/backlog/issues).

### Shipped

Merged to `main`: the examples in the table above. Of the E22 items, the
following have a merged deliverable:

| Item | Deliverable | Reason it counts as shipped |
|---|---|---|
| 0568 batch registration recipes | [`batch-register`](batch-register) with JSON and CSV fixtures | The example and its README document both input formats. |
| 0567 Rust calling-contract example | [`rust-sdk/examples/calling-contract`](../rust-sdk/examples/calling-contract) | The example crate exists. A written walkthrough, which 0567 asks for, was not found in the repository. |

### In review, not yet shipped

These have an open pull request. They are listed here, not under "shipped",
because they are not on `main`.

| Items | Pull request |
|---|---|
| 0555 TTL extension, 0556 recurring payment, 0557 token vesting, 0559 limit order | [#924](https://github.com/soroban-tooling/soroban-keeper-network/pull/924) |
| 0558 auction settlement, 0560 dollar-cost averaging, 0565 owner script, 0566 governance execution | [#926](https://github.com/soroban-tooling/soroban-keeper-network/pull/926), [#912](https://github.com/soroban-tooling/soroban-keeper-network/pull/912) |
| 0561 liquidation keeper (TypeScript), 0562 hash-preimage verifier, 0563 condition template, 0564 Next.js starter | [#927](https://github.com/soroban-tooling/soroban-keeper-network/pull/927) |
| 0553 examples index, 0554 local quickstart | [#925](https://github.com/soroban-tooling/soroban-keeper-network/pull/925) |

### Not started

| Item | Why |
|---|---|
| 0569 deploy the examples to testnet and list them ([#808](https://github.com/soroban-tooling/soroban-keeper-network/issues/808)) | Depends on 0555 and 0556, which are not merged. |
| 0570 build and test every example in CI ([#809](https://github.com/soroban-tooling/soroban-keeper-network/issues/809)) | Depends on 0555, which is not merged. Until it lands, CI builds only the packages it already has jobs for. |

### Dropped

No E22 item has been formally dropped, and none is closed as "won't do" in
the tracker. Two scoping decisions are worth recording so nobody mistakes them
for omissions:

- **No reference verifier contracts.** The verifier interface and its
  registry hook exist ([`docs/VERIFIER_DESIGN.md`](../docs/VERIFIER_DESIGN.md)),
  but the reference verifiers from epic E04 (issues 0077 to 0079) were never
  built, as [`docs/VERIFIERS.md`](../docs/VERIFIERS.md) records. The
  hash-preimage verifier in 0562 is therefore the only verifier example, and
  it is still in review. The integration guide tells protocol teams to write
  their own verifier until more exist.
- **Examples live in several places.** Keeper and owner tooling is under
  `examples/`, Rust examples under `rust-sdk/examples/`, and TypeScript SDK
  examples under `packages/sdk-ts/examples/`. They were not consolidated,
  because each is tested with its own package.

### What integrators asked for

No integrator feedback is recorded in the issue tracker or the repository at
the time of writing, so this section does not invent any. The gaps that the
epic's own acceptance criteria and the review above point to, in the order a
protocol team hits them, are:

1. A guide that connects the examples to the decisions a protocol team has to
   make. This is now [`docs/INTEGRATION_GUIDE.md`](../docs/INTEGRATION_GUIDE.md).
2. A one-command local network quickstart (0554, in review).
3. Examples that run in CI, so they cannot rot (0570, not started).
4. Testnet deployments of the examples to try without deploying anything
   (0569, not started).

### Follow-ups

- Merge the in-review pull requests, then update the tables above. Note that
  [#925](https://github.com/soroban-tooling/soroban-keeper-network/pull/925),
  [#926](https://github.com/soroban-tooling/soroban-keeper-network/pull/926)
  and
  [#927](https://github.com/soroban-tooling/soroban-keeper-network/pull/927)
  also edit this file, so they will need their entries merged into it.
- Close 0570 first: it protects every other example.
- Write the 0567 walkthrough for `calling-contract`.
