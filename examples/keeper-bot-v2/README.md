# Soroban Keeper Bot v2

**This is the operator-grade keeper bot.** It is aimed at teams running a keeper
competitively — with persistent task state, concurrent round processing, and
runtime-tunable configuration — not at newcomers exploring the Keeper Network
for the first time.

> **Looking for a simple starting point?**  
> See [`examples/keeper-bot`](../keeper-bot) — a single-file, dependency-light
> example that is deliberately kept beginner-friendly.

---

## Configuration and hot reloading

All configuration is read from environment variables (copy `.env.example` to
`.env` and fill in your values).

Configuration values are divided into two categories:

### Hot-reloadable

These values are re-read from the environment before every evaluation round.
A change takes effect within one round — no restart required.

| Variable | Default | Description |
|---|---|---|
| `POLL_INTERVAL_MS` | `10000` | Polling interval in milliseconds (integer, ≥ 1000) |
| `WITHDRAW_THRESHOLD` | `10000000` | Auto-withdraw when balance exceeds this (stroops) |
| `MAX_TASKS_PER_ROUND` | `5` | Maximum tasks processed per round (integer, ≥ 1) |
| `MAX_RETRIES` | `3` | Retry attempts for transient RPC errors (integer, ≥ 0) |
| `RETRY_BASE_MS` | `500` | Base delay for exponential back-off (integer, > 0) |
| `EXPIRE_STALE_TASKS` | `true` | Call `expire_task` on past-deadline tasks |
| `MIN_PROFIT_MARGIN_STROOPS` | `0` | Skip tasks below this net profit threshold |
| `SIMULATE_EXECUTION` | `false` | Dev-only: fabricate proofs when no real executor exists |

### Restart-required

These values are consumed during process initialisation. Changing them requires
a restart. If a change is detected at reload time, it is logged as a warning —
it is **never silently ignored** and **never partially applied**.

| Variable | Description |
|---|---|
| `NETWORK` | `testnet` \| `futurenet` \| `mainnet` |
| `REGISTRY_CONTRACT_ID` | Deployed KeeperRegistry contract ID |
| `KEEPER_SECRET_KEY` | Keeper signing key — never logged, never echoed |
| `DRY_RUN` | Run without submitting transactions (no signing key required) |

### Reload safety guarantees

- **Invalid values are rejected.** The same validation rules enforced at startup
  are enforced on every reload. An invalid environment variable causes the
  entire reload to be aborted; the previous valid configuration is retained.
- **No partial updates.** Either all hot-reloadable changes in a reload pass
  validation and are applied, or none are applied.
- **Restart-required values are never applied mid-run.** Detecting and logging
  a restart-required change does not affect the running process.
- **Secrets are never logged.** `KEEPER_SECRET_KEY` and any other `secret: true`
  field are replaced with `<redacted>` in all change-detection output.

---

## Development

```sh
cp .env.example .env
# fill in your values

npm install
npm test
npm run lint
```

---

## Architecture

Source files live under `src/`:

| File | Responsibility |
|---|---|
| `src/config.js` | Configuration loading, validation, and hot-reload (this issue) |

Further modules — runtime loop, persistent state, concurrency control,
profitability, fee adaptation — are added by subsequent issues in epic E15.
