# Soroban Keeper Bot v2

> **Notice for newcomers**: This package is **v2**, an advanced, concurrent keeper bot tailored for production node operators. If you are learning how to build on the Soroban Keeper Network or want a simple, beginner-friendly single-file reference, please refer to [`examples/keeper-bot`](../keeper-bot/) instead.

---

## Features

- **Concurrent Round Execution**: Configurable async worker pool (`MAX_CONCURRENCY`) to process independent tasks in parallel without intra-process contention.
- **Dynamic Task Prioritization**: Evaluates candidate tasks by estimated net profit (`reward - estimatedGas - margin`) and ranks them so high-value tasks are claimed first.
- **Hard Spend Ceiling Backstop (Issue #407)**: Enforces an independent per-round resource fee cap (`MAX_ROUND_SPEND_STROOPS`) as a safety guardrail against candidate bursts or fee spikes.
- **Multi-Keeper Competition Resiliency (Issue #404)**: Gracefully handles lost claim races (`TaskAlreadyClaimed`) as normal competitive skips (`success-with-skip`), preserving round momentum without error pollution.
- **Operational Metrics**: In-memory counters tracking evaluated, claimed, executed, and skipped tasks (broken down by distinct skip reason including lost race, spend ceiling, and unprofitability).
- **Deferred Verifier Support (Issue #412)**: Verifier-aware proof generation is deferred until on-chain contract support (`Task.verifier`, registry verifier entry points, and verification hooks) is implemented.

---

## Configuration

| Environment Variable | Description | Default |
|---|---|---|
| `SOROBAN_RPC_URL` | URL of the Soroban RPC node | Required |
| `KEEPER_SECRET_KEY` | Stellar secret key for signing transactions | Required |
| `KEEPER_CONTRACT_ID` | Contract address of KeeperRegistry | Required |
| `MAX_ROUND_SPEND_STROOPS` | Hard ceiling on total transaction fees per round | `5000000` (0.5 XLM) |
| `MAX_CONCURRENCY` | Maximum concurrent task workers per round | `4` |
| `MIN_PROFIT_MARGIN_STROOPS` | Minimum net profit required before claiming | `0` |
| `POLL_INTERVAL_MS` | Delay between consecutive keeper rounds | `5000` |
| `SIMULATE_EXECUTION` | Enable fallback simulated executor for dev | `false` |

---

## Testing & Benchmarks

Run unit and integration test suites:
```bash
npm test
```

Run latency and throughput benchmark against v1:
```bash
npm run benchmark
```
Benchmark report is committed at [`benchmark/REPORT.md`](benchmark/REPORT.md).
