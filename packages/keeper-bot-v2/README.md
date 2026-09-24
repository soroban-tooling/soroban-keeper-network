# Keeper Bot v2

Production-ready keeper bot for the Soroban Keeper Network, featuring:

- Graceful degradation during extended RPC outages
- Pluggable alerting on missed executions and persistent errors
- Persistent task state to prevent double-claiming
- Concurrent task processing with resource budgets
- Prometheus metrics endpoint

**⚠️ v2 is aimed at operators running keepers competitively. For newcomers, see `examples/keeper-bot` (v1) instead.**

## Getting Started

```bash
npm install @soroban-keeper-network/keeper-bot-v2
cp .env.example .env
npm run build
npm start
```

## Configuration

See `.env.example` for all available configuration options.

Key degraded-mode settings:
- `CONSECUTIVE_EXHAUSTED_RETRIES_FOR_DEGRADED_MODE` - Threshold for entering degraded mode (default: 3)
- `DEGRADED_MODE_POLLING_INTERVAL_MS` - Polling interval during RPC outages (default: 60000)

## Development

```bash
npm run build     # Compile TypeScript
npm run lint      # Check code style
npm test          # Run test suite
```
