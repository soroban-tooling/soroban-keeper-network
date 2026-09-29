# Runtime Inspection Guide

This document explains how to use the keeper-bot-v2 runtime inspection commands to query a live running bot's state without restarting.

## Overview

The keeper-bot-v2 package provides three core inspection capabilities:

1. **Task State Inspection** — Query persisted state for a specific task ID
2. **Configuration Inspection** — Dump the current runtime configuration (with secrets redacted)
3. **Skip Decision Inspection** — Review recent skip decisions and their reasons

All inspection is read-only and does not require restarting the bot.

## Prerequisites

1. A running keeper-bot-v2 instance (in daemon mode)
2. Access to the same state database file (configured via `STATE_DB_PATH`)
3. The `keeper-bot` CLI installed and accessible

## Commands

### Inspect Task State

Query what this keeper has done with a specific task.

```bash
keeper-bot inspect task <task-id>
```

**Example:**

```bash
$ keeper-bot inspect task 42
{
  "taskId": 42,
  "status": "executed",
  "keeperAddress": "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  "actionTimestamp": 1705334456,
  "actionTimestampIso": "2024-01-15T12:34:16.000Z",
  "outcome": "proof: abc123def456..."
}
```

**Possible Status Values:**

- `unknown` — Task has not been interacted with by this keeper
- `claimed` — Keeper has claimed the task but not yet executed
- `executed` — Keeper has submitted execution with proof
- `expired` — Keeper has marked the task as expired (past deadline)

**Output Fields:**

- `taskId` — The task ID
- `status` — One of the status values above
- `keeperAddress` — The Soroban address of the keeper (if status != unknown)
- `actionTimestamp` — Unix timestamp (seconds) of the action
- `actionTimestampIso` — ISO 8601 timestamp for human readability
- `outcome` — Optional details about the action result

### Inspect Configuration

Dump the current runtime configuration with all secrets redacted.

```bash
keeper-bot inspect config
```

**Example:**

```bash
$ keeper-bot inspect config
{
  "network": "testnet",
  "registryContractId": "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4",
  "keeperAddress": "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  "rpcUrl": "https://soroban-testnet.stellar.org",
  "pollIntervalMs": 10000,
  "withdrawThreshold": "10000000",
  "maxTasksPerRound": 5,
  "maxRetries": 3,
  "retryBaseMs": 500,
  "expireStaleTasks": true,
  "minProfitMarginStroops": "0",
  "stateDbPath": "./keeper-state.db",
  "simulateExecution": false,
  "secretKey": "***REDACTED***",
  "networkPassphrase": "Test SDF Network ; September 2015"
}
```

**Secret Redaction:**

The following fields are always redacted:

- `secretKey`
- `KEEPER_SECRET_KEY`
- Any field named `token`, `apiKey`, `password`, `credential`, etc.
- Any values that appear to be Stellar secret keys or other sensitive data

This ensures operators can inspect configuration without accidentally exposing signing keys or credentials.

### Inspect Skip Decisions

Review recent skip decisions to understand why tasks are or aren't being executed.

```bash
keeper-bot inspect skip-decisions [--limit N] [--task-id ID] [--stats]
```

**Examples:**

```bash
# Show the 100 most recent skip decisions
$ keeper-bot inspect skip-decisions

# Show the 50 most recent skip decisions
$ keeper-bot inspect skip-decisions --limit 50

# Show skip decisions for a specific task
$ keeper-bot inspect skip-decisions --task-id 42

# Show skip decisions with statistics
$ keeper-bot inspect skip-decisions --limit 100 --stats
```

**Output Example:**

```bash
$ keeper-bot inspect skip-decisions --limit 3 --stats
{
  "decisions": [
    {
      "taskId": 45,
      "reason": "unprofitable",
      "timestamp": 1705334400,
      "timestampIso": "2024-01-15T12:30:00.000Z",
      "taskInfo": {
        "reward": 10000,
        "estimated_gas": 60000,
        "margin": 0
      },
      "details": "Task not profitable: gas=60000, reward=10000, margin=0"
    },
    {
      "taskId": 44,
      "reason": "deadline_passed",
      "timestamp": 1705334350,
      "timestampIso": "2024-01-15T12:29:10.000Z",
      "details": "Task deadline has passed"
    },
    {
      "taskId": 43,
      "reason": "no_executor",
      "timestamp": 1705334300,
      "timestampIso": "2024-01-15T12:28:20.000Z",
      "taskInfo": {
        "task_type": "CustomLiquidation"
      },
      "details": "No executor registered for task type: CustomLiquidation"
    }
  ],
  "count": 3,
  "stats": {
    "deadline_passed": 1250,
    "unprofitable": 850,
    "no_executor": 420,
    "claim_race_lost": 180,
    "other_error": 30
  }
}
```

**Skip Reason Codes:**

- `deadline_passed` — Task deadline has already passed
- `unprofitable` — Task reward does not cover estimated gas costs and profit margin
- `no_executor` — No executor is registered for this task type
- `unsupported_verifier` — The task's verifier is not supported
- `proof_generation_failed` — Could not generate valid proof before claiming
- `claim_race_lost` — Another keeper claimed the task first
- `simulation_failed` — Transaction simulation failed during verification
- `other_error` — Some other error occurred

**Output Fields:**

- `decisions` — Array of skip decision records
  - `taskId` — The task ID
  - `reason` — The skip reason code
  - `timestamp` — Unix timestamp (seconds)
  - `timestampIso` — ISO 8601 timestamp
  - `taskInfo` — Optional structured information about the task
  - `details` — Human-readable description of the reason
- `count` — Number of decisions returned
- `stats` — (optional) Aggregate counts by reason over the analyzed period

## Architecture

### Persistent State Storage

Inspection commands query an SQLite database (configured via `STATE_DB_PATH`) that persists:

1. **Task Outcomes** — What this keeper has done with each task
2. **Skip Decisions** — Reasons tasks were skipped with timestamps and context

This persistent state allows operators to:

- Debug specific task decisions after the fact
- Understand patterns in skip reasons
- Verify that task state survived a keeper restart

### Read-Only Access

All inspection commands are read-only:

- They do not modify any state
- They do not affect the running keeper loop
- Multiple inspection queries can run concurrently with the keeper

### No Restart Required

Inspection works directly against the running bot's state database:

- No special configuration or startup mode needed
- Changes to the running bot are visible immediately
- Useful for real-time debugging while the keeper is operating

## Security Considerations

### Secret Redaction

All inspection output is carefully redacted to prevent accidental secret disclosure:

1. **Configuration dumps** redact signing keys, tokens, and credentials
2. **All output** is scanned for Stellar secret key patterns and other sensitive data
3. **Heuristic detection** catches secrets even if they have unexpected key names

The redaction logic is centralized in `src/secrets.ts` and follows the same discipline v1's `requireEnv()` established.

### No Credential Exposure

The inspection commands:

- Never log or output the keeper's signing key
- Never include environment secrets in output
- Never expose tokens or API credentials
- Only expose information necessary for operational debugging

### Output Verification

The test suite includes dedicated security tests:

- Verify that configuration dumps contain no secrets
- Verify that skip decision output is safe to log
- Verify that task state output contains no sensitive information
- Heuristic detection tests for common secret patterns

## Operational Workflows

### Debugging Why a Task Was Skipped

```bash
# Check the task's persisted state
keeper-bot inspect task 42

# Check recent skip decisions for this specific task
keeper-bot inspect skip-decisions --task-id 42
```

### Understanding Current Profitability

```bash
# Check configuration to see profit margin settings
keeper-bot inspect config | grep profit

# Check recent unprofitable skip decisions
keeper-bot inspect skip-decisions --limit 1000 --stats
# Look for high counts of "unprofitable" in the stats
```

### Verifying Configuration After Deployment

```bash
# Quickly verify that configuration was applied correctly
keeper-bot inspect config

# Spot-check that RPC URL and registry contract ID are correct
keeper-bot inspect config | grep -E "(rpcUrl|registryContractId)"
```

### Monitoring Skip Reason Trends

```bash
# Get statistics over the last 1000 skip decisions
keeper-bot inspect skip-decisions --limit 1000 --stats

# If a particular reason is spiking, investigate why
# E.g., if "no_executor" is high, check whether executors are loaded
```

## Troubleshooting

### "Error: STATE_DB_PATH not found"

The state database file doesn't exist at the configured path. Ensure:

1. The keeper-bot is actually running (and has created the database)
2. `STATE_DB_PATH` environment variable is set correctly
3. You have read permission to the database file

### "Error: task-id must be a valid number"

The task ID argument is not a valid integer. Example:

```bash
# Wrong
keeper-bot inspect task ABC

# Correct
keeper-bot inspect task 42
```

### Inspection output shows "unknown" status for a task I know I processed

Possible causes:

1. **Different database paths** — Ensure you're using the same `STATE_DB_PATH` as the running bot
2. **Different network/contract** — The inspection is reading a different bot's database
3. **Task is very recent** — State writes are synchronous but there may be timing delays

### Secret appears unredacted in output

This is a security issue. Please report it:

1. Note the exact command that produced the output
2. Do NOT share the output publicly
3. Create a confidential issue or contact maintainers

## API Reference

For programmatic access to inspection functionality, see:

- `src/inspect.ts` — Inspection command implementations
- `src/config.ts` — Configuration loading and validation
- `src/state/schema.ts` — Persistent state queries
- `src/secrets.ts` — Secret redaction utilities

Example:

```typescript
import { loadConfig, getDatabase, inspectTask } from '@soroban-keeper-network/keeper-bot-v2';

const config = loadConfig();
const db = getDatabase(config.stateDbPath);
const taskState = inspectTask(db, 42);
console.log(taskState);
```

## See Also

- [README.md](./README.md) — Overview and quick start
- [../examples/keeper-bot](../../examples/keeper-bot) — v1 beginner-friendly bot
- [docs/KEEPER_BOT_V2_DESIGN.md](../../docs/KEEPER_BOT_V2_DESIGN.md) — Architectural decisions
