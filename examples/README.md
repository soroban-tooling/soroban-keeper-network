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
