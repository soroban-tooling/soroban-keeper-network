# Soroban Keeper Network - Keeper Bot v2

A TypeScript-based keeper bot for the Soroban Keeper Network designed for operators running keepers competitively with adaptive fee management, profitability checks, persistence, concurrency, metrics, and alerting.

## Overview

This is **keeper-bot-v2**, aimed at operators and enterprises running keeper operations at scale. It differs from the simpler [examples/keeper-bot](../keeper-bot) in several ways:

- **TypeScript**: Type-safe, production-ready implementation
- **Adaptive Fees**: Adjusts transaction fees based on current network conditions within configurable limits
- **Profitability Checks**: Evaluates whether each task execution will be profitable before submission
- **Persistence**: Durable task state tracking across restarts
- **Concurrency**: Parallel task processing for improved throughput
- **Metrics**: Operational observability with comprehensive metrics collection
- **Alerting**: Real-time alerts for missed executions, RPC errors, and stagnant balance
- **Modular Architecture**: Pluggable components for custom executors, state persistence, and transport layers

If you're new to the Soroban Keeper Network, start with [examples/keeper-bot](../keeper-bot) instead — it's a single-file JavaScript example designed to be beginner-friendly.

## Features

### Adaptive Fee Management

The bot queries Soroban RPC for current network fee conditions and adjusts submission fees accordingly:

- **Network-aware**: Uses p10, p50, p90, or p99 fee percentiles from recent ledgers
- **Ceiling-bounded**: Never exceeds the operator's configured maximum fee
- **Configurable**: Tunable via environment variables for different risk/cost tradeoffs
- **Fallback strategy**: Reverts to BASE_FEE if RPC is unavailable

### Profitability Checks

Before claiming and executing a task, the bot evaluates:

```
Net Profit = Gross Reward - (claim fee + execute fee + withdraw fee)
```

If net profit ≤ 0, the task is skipped — no point paying to lose money.

### Alerting System

Production-grade alerting with:

- **Missed Execution Detection**: Alerts when claimed tasks are not executed within lock window
- **RPC Error Tracking**: Detects consecutive RPC failures
- **Balance Monitoring**: Warns when keeper balance is stagnant despite activity
- **Pluggable Transports**: Webhook, Slack, PagerDuty, or custom implementations

### Metrics Collection

Track operational health with:

- Claimed/executed task counts
- Profit metrics and fee statistics
- RPC error rates
- Balance changes
- Concurrency metrics

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

2. Edit `.env` and set your keeper account and preferences:

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

Compiles TypeScript to `dist/` directory.

### Run Tests

```bash
npm test
```

Run tests in watch mode during development:

```bash
npm run test:watch
```

### Type Check

```bash
npm run type-check
```

Verifies TypeScript types without building.

### Linting

```bash
npm run lint
```

Validates code against repository style guidelines.

## Architecture

### Components

- **Profitability Module**: Evaluates task profitability with actual fees
- **Adaptive Fee Module**: Queries RPC and adjusts fees based on network conditions
- **Alerting System**: Monitors metrics and sends notifications via pluggable transports
- **Metrics Collection**: Aggregates operational data for observability
- **Task Persistence**: Durable state tracking for resilience
- **Executor**: Pluggable task execution strategies

### Alert Rules

#### 1. MissedExecutionRule
Detects when a claimed task is not executed within its lock window.

#### 2. ConsecutiveRpcErrorRule
Detects when consecutive rounds with RPC errors exceed a threshold.

#### 3. StagnantBalanceRule
Detects when the keeper balance is not growing despite claimed activity.

### Deduplication

The AlertManager ensures exactly one notification per incident:

- Fires on first detection
- Suppresses duplicates while condition persists
- Clears incident when condition resolves
- Can re-fire if condition recurs

## Usage

(Coming soon — awaiting executor and task source implementations)

The bot will follow this flow:

1. **Fetch tasks** from the Keeper Registry contract
2. **Collect metrics** on current operational state
3. **Check profitability** using actual adaptive fees
4. **Skip unprofitable tasks** without wasting fees
5. **Claim and execute** profitable tasks with network-adapted fees
6. **Evaluate alerts** based on metrics
7. **Persist state** across restarts for resilience

## Roadmap

- [x] Adaptive fee module with RPC integration
- [x] Profitability check integration
- [x] Alerting system with webhook transport
- [x] Metrics collection framework
- [ ] Executor plugin interface
- [ ] Persistent task state schema
- [ ] Multi-account support for parallelization
- [ ] Concurrent task processing
- [ ] CLI for administration and monitoring
- [ ] Slack/PagerDuty/Datadog transports

## Related Issues

- **Issue #260**: Adapt submitted fees to current network conditions
- **Issue #254**: Profitability check before claiming
- **Issue #252**: Persistent task-state schema
- **Issue #253**: Concurrent task processing
- **Issue #257**: Metrics collection endpoint
- **Issue #258**: Alerting system with webhook transport

## Testing

The test suite covers:

- ✓ Adaptive fee calculation with various network conditions
- ✓ Fee ceiling enforcement during extreme congestion
- ✓ Profitability checks with actual fees
- ✓ Alert rule detection and deduplication
- ✓ Metrics collection and aggregation
- ✓ Configuration loading and validation
- ✓ Transport error handling and timeouts

Run `npm test` to see the full output.

## Contributing

See [CONTRIBUTING.md](../../CONTRIBUTING.md) for contribution guidelines.

Keeper-bot-v2 is part of epic E15 in the Soroban Keeper Network roadmap.

## License

Apache 2.0 — see [LICENSE](../../LICENSE)
