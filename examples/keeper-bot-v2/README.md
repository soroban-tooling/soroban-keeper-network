# Soroban Keeper Network - Keeper Bot v2

A TypeScript-based keeper bot for the Soroban Keeper Network designed for operators running keepers competitively with adaptive fee management and profitability checks.

## Overview

This is **keeper-bot-v2**, aimed at operators and enterprises running keeper operations at scale. It differs from the simpler [examples/keeper-bot](../keeper-bot) in several ways:

- **TypeScript**: Type-safe, production-ready implementation
- **Adaptive Fees**: Adjusts transaction fees based on current network conditions within configurable limits
- **Profitability Checks**: Evaluates whether each task execution will be profitable before submission
- **Modular Architecture**: Pluggable components for custom executors, state persistence, and more

If you're new to the Soroban Keeper Network, start with [examples/keeper-bot](../keeper-bot) instead — it's a single-file JavaScript example designed to be beginner-friendly.

## Features

### Adaptive Fee Management (Issue #260)

The bot queries Soroban RPC for current network fee conditions and adjusts submission fees accordingly:

- **Network-aware**: Uses p10, p50, p90, or p99 fee percentiles from recent ledgers
- **Ceiling-bounded**: Never exceeds the operator's configured maximum fee
- **Configurable**: Tunable via environment variables for different risk/cost tradeoffs
- **Fallback strategy**: Reverts to BASE_FEE if RPC is unavailable

Example scenarios:

- **Quiet network**: Use p50 (median) with 1.0x multiplier to save costs
- **Normal conditions**: Use p90 with 1.1x multiplier for reliable inclusion
- **High congestion**: Use p99 with a high multiplier or accept the ceiling limit

### Profitability Checks (Issue #254)

Before claiming and executing a task, the bot evaluates:

```
Net Profit = Gross Reward - (claim fee + execute fee + withdraw fee)
```

If net profit ≤ 0, the task is skipped — no point paying to lose money.

The profitability check uses the **actual adaptive fee** about to be paid, not a hardcoded assumption, so fees and profitability always stay in sync.

## Setup

### Prerequisites

- Node.js 18+
- npm or yarn
- A Stellar account with funds for transaction fees (testnet or mainnet)
- Soroban RPC endpoint (e.g., https://soroban-testnet.stellar.org)

### Installation

```bash
cd examples/keeper-bot-v2
npm install
```

### Configuration

1. Copy `.env.example` to `.env`:

   ```bash
   cp .env.example .env
   ```

2. Edit `.env` and set your keeper account and fee preferences:

   ```env
   KEEPER_SECRET_KEY=S...  # Your keeper's secret key
   FEE_CEILING_STROOPS=10000  # Max fee you'll ever pay
   FEE_PERCENTILE=p90       # Target network percentile
   FEE_MULTIPLIER=1.1       # Urgency multiplier
   ```

## Building and Testing

### Build

```bash
npm run build
```

### Run Tests

```bash
npm test
```

Run tests in watch mode during development:

```bash
npm run test:watch
```

### Linting

```bash
npm run lint
```

## Usage

(Coming soon — awaiting executor and task source implementations)

The bot will follow this flow:

1. **Fetch tasks** from the Keeper Registry contract
2. **Check profitability** using actual adaptive fees
3. **Skip unprofitable tasks** without wasting fees
4. **Claim and execute** profitable tasks with network-adapted fees
5. **Persist state** across restarts for resilience

## Architecture

### Modules

- **fees.ts**: Adaptive fee calculation, RPC integration, profitability checks
- **config.ts**: Environment variable loading and validation
- *(future)* **executor.ts**: Pluggable task execution strategies
- *(future)* **state.ts**: Persistent state schema and storage
- *(future)* **keeper.ts**: Main orchestration loop

### Key Interfaces

```typescript
// From fees.ts
export interface FeeConfig {
  feeCeilingStroops: number;
  feePercentile?: "p10" | "p50" | "p90" | "p99";
  feeMultiplier?: number;
}

export interface FeeEstimate {
  recommendedFee: number;
  adaptedFromNetwork: boolean;
  networkFeeRaw?: number;
  ceilingApplied: boolean;
}

// Query fees and check profitability
const estimate = await getAdaptiveFee(server, config);
const isProfitable = isOperationProfitable(grossProfit, estimate);
```

## Fee Configuration Guidance

### Conservative (Testnet, Low-Risk)

```env
FEE_CEILING_STROOPS=1000
FEE_PERCENTILE=p50
FEE_MULTIPLIER=1.0
```

- Aims for median fee
- Lowest cost, moderate inclusion probability
- Good for testing on testnet

### Balanced (Production, Recommended)

```env
FEE_CEILING_STROOPS=10000
FEE_PERCENTILE=p90
FEE_MULTIPLIER=1.1
```

- Aims for 90th percentile with 10% safety margin
- Reliable inclusion, reasonable cost
- Recommended for most operators

### Aggressive (High-Value Tasks, Testnet Spikes)

```env
FEE_CEILING_STROOPS=50000
FEE_PERCENTILE=p99
FEE_MULTIPLIER=1.5
```

- Aims for 99th percentile with 50% safety margin
- Highest inclusion probability, higher cost
- Use only for high-value tasks or during congestion

## Roadmap

- [x] Adaptive fee module with RPC integration
- [x] Profitability check integration
- [ ] Executor plugin interface
- [ ] Persistent task state schema
- [ ] Multi-account support for parallelization
- [ ] Concurrent task processing
- [ ] CLI for administration and monitoring
- [ ] Metrics and observability (Prometheus, etc.)

## Issues and Related Work

This implementation addresses:

- **Issue #260**: [Adapt submitted fees to current network conditions](../../.github/backlog/issues/0260-bot-v2-fee-market-adaptation.md)
- **Issue #254**: [Profitability check before claiming](../../.github/backlog/issues/0254-bot-v2-profitability-check.md)

Related future work:

- Issue #251: Keeper-bot-v2 scaffolding
- Issue #252: Persistent task-state schema
- Issue #253: Concurrent task processing
- Issue #255: Multi-account support
- Issue #256: Executor plugin interface

See [.github/backlog/README.md](../../.github/backlog/README.md) for the full issue index.

## Testing

The test suite covers:

- ✓ Adaptive fee calculation with various network conditions
- ✓ Fee ceiling enforcement during extreme congestion
- ✓ Percentile selection (p10, p50, p90, p99)
- ✓ RPC fallback behavior
- ✓ Profitability checks with actual fees
- ✓ Configuration loading and validation

Run `npm test` to see the full output.

## Contributing

See [CONTRIBUTING.md](../../CONTRIBUTING.md) for contribution guidelines.

Keeper-bot-v2 is part of epic E15 in the Soroban Keeper Network roadmap.

## License

Apache 2.0 — see [LICENSE](../../LICENSE)
