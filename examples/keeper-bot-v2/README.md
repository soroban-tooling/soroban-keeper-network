# Soroban Keeper Bot v2

A high-performance, modular off-chain keeper bot for the [Soroban Keeper Network](https://github.com/soroban-tooling/soroban-keeper-network).

> [!NOTE]
> If you are a newcomer to Soroban, building a first integration, or exploring the smart contract ABI, start with the introductory single-file bot in [`examples/keeper-bot`](../keeper-bot).
> 
> **Keeper Bot v2** is intended for operators running competitive keepers with requirements for concurrency, custom withdrawal schedules, lock-window-aware scheduling, and state persistence.

---

## 🚀 Key Architectural Capabilities

### 1. Graceful Shutdown Guarantee Under Concurrency (`src/shutdown.js`)
* **Worker Draining**: When a `SIGINT` or `SIGTERM` signal is received, the bot stops accepting new candidate tasks and drains all active in-flight workers.
* **No Mid-Submission Kills**: Each concurrent worker finishes its current submission and persists its outcome before the process exits.
* **Bounded Maximum Wait**: Uses a configurable maximum drain ceiling (`maxDrainMs`) to prevent a deadlocked worker or hung network connection from blocking shutdown indefinitely.

### 2. Pluggable Withdrawal Strategies (`src/withdrawal.js`)
* **Default Fixed-Threshold Strategy**: Matches the v1 threshold behavior exactly (`WITHDRAW_THRESHOLD`, defaulting to 1 XLM), ensuring seamless zero-configuration migrations.
* **Fixed-Schedule Strategy**: Automatically triggers withdrawals on a time or ledger interval (e.g. hourly or daily) for accounting, liquidity, or tax management.
* **Fee-Aware Strategy**: Dynamically adjusts withdrawal floors to trigger payouts opportunistically when Stellar network base fees are low.
* **Custom Strategy Interface**: Fully pluggable interface allows operators to implement custom logic (e.g., epoch-based treasury sweeps).

### 3. Lock-Window-Aware Scheduling (`src/scheduling.js`)
* **Exact Contract Arithmetic**: Computes the exact ledger when a locked task becomes re-claimable (`claim_ledger + lock_ledgers`), matching `contracts/keeper-registry/src/internal.rs`.
* **Targeted Re-checks**: Rather than waiting for a full periodic event scan to rediscover expired locks, the bot schedules targeted re-checks right at the unlock ledger boundary.
* **Additive Discovery**: Re-check candidate tasks are merged additively with standard polling without disrupting the discovery of newly registered tasks.

---

## 🛠️ Testing & Verification

Run the test suite using Node's built-in test runner:

```bash
npm test
```

Run linting:

```bash
npm run lint
```

For design rationale, comparison with the Rust SDK example, and architecture specifications, see [`docs/KEEPER_BOT_V2_DESIGN.md`](../../docs/KEEPER_BOT_V2_DESIGN.md).
