# Soroban Keeper Bot v2

> **Notice for Newcomers:** This package is **keeper-bot-v2**, engineered specifically for production operators who require concurrent task processing, multi-account transaction submission, persistent state tracking across restarts, Prometheus metrics, and strict startup validation.
>
> If you are exploring the Soroban Keeper Network for the first time or looking for an educational, single-file, zero-dependency walkthrough, please refer to the beginner-friendly [v1 Keeper Bot](../keeper-bot) instead.

---

## Overview

Keeper Bot v2 is a high-throughput, enterprise-ready off-chain daemon for the Soroban Keeper Network. Key features include:

- **Full Startup Configuration Schema Validation**: Performs both per-field validation and cross-field consistency checks (e.g. concurrency limits vs account pool size, profitability margins vs fee ceilings) to fail fast before any runtime operations begin.
- **Per-Task-Type Observability**: Exposes detailed metrics broken down by `task_type` (claimed, executed, skipped counts by reason, and net profit per type) in Prometheus exposition format.
- **Persistent State & Idempotency**: Backed by PostgreSQL (`DATABASE_URL`) to record task outcomes and prevent duplicate claims or executions across restarts.
- **Multi-Account Concurrency**: Distributes tasks across multiple signing accounts in `SIGNING_KEY_POOL` to bypass single-account sequence number serialization.
- **Pluggable Executors**: Discoverable executor modules with automatic metrics registration.

---

## Quickstart

### Prerequisites
- Node.js >= 18.0.0
- A funded Stellar account (secret key starting with `S...`) or key pool
- PostgreSQL database instance (for persistent task tracking)
- Deployed `KeeperRegistry` contract ID (starting with `C...`)

### Installation & Configuration
```bash
# Install dependencies
npm install

# Copy configuration template
cp .env.example .env

# Build TypeScript
npm run build

# Run tests
npm test

# Run linter
npm run lint

# Start daemon
npm start
```

For migration instructions from v1, see [docs/KEEPER_BOT_V2_MIGRATION.md](../../docs/KEEPER_BOT_V2_MIGRATION.md).
