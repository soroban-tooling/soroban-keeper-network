# Integration Guide — Inspection Commands with Keeper Loop

This guide explains how to integrate the runtime inspection infrastructure with the keeper-bot-v2's main keeper loop and other components. This is a reference for whoever implements issue #0251 (keeper-bot-v2 scaffolding) and the keeper loop itself.

## Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│              keeper-bot-v2 Process                      │
├─────────────────────────────────────────────────────────┤
│                                                          │
│  ┌──────────────────────────────────────┐              │
│  │   Main Keeper Loop (keeperLoop)      │              │
│  │  - Poll for tasks                    │              │
│  │  - Claim/execute/expire              │              │
│  │  - Record outcomes in DB              │◄─────┐      │
│  │  - Calculate profitability            │      │      │
│  │  - Track skip decisions               │      │      │
│  └──────────────────────────────────────┘      │      │
│                                                 │      │
│  ┌──────────────────────────────────────┐      │      │
│  │   Persistent State (SQLite)          │      │      │
│  │  - Task outcomes table               │      │      │
│  │  - Skip decisions table               │      │      │
│  └──────────────────────────────────────┘      │      │
│                 ▲                              │      │
│                 │                              │      │
│                 └──────────────────────────────┘      │
│                                                       │
│  ┌──────────────────────────────────────┐          │
│  │   Inspection Commands (Read-Only)    │          │
│  │  - inspect task <id>                 │          │
│  │  - inspect config                    │          │
│  │  - inspect skip-decisions            │          │
│  │  (No restart required)                │          │
│  └──────────────────────────────────────┘          │
│                 │                                   │
│                 └───────────────────────────────────┘
│                      (Query only, no mutation)
│
└─────────────────────────────────────────────────────────┘
         │
         └─► CLI: keeper-bot start
             CLI: keeper-bot inspect ...
```

## Database Connection Management

### Initialization

The database should be initialized once at startup:

```typescript
import { getDatabase } from '@soroban-keeper-network/keeper-bot-v2';

async function main() {
  const config = loadConfig();
  const db = getDatabase(config.stateDbPath);
  // ^ This initializes the schema if needed, creates tables, runs migrations
  
  // Now run the keeper loop
  await keeperLoop(db, config);
}
```

### Cleanup on Shutdown

Close the database connection during graceful shutdown:

```typescript
import { closeDatabase } from '@soroban-keeper-network/keeper-bot-v2';

process.on('SIGINT', async () => {
  console.log('Shutting down...');
  // Wait for in-flight round to complete
  await finishCurrentRound();
  closeDatabase();
  process.exit(0);
});
```

### Connection Reuse

The database connection is a singleton within the process:

```typescript
// In keeperLoop (called every round)
import { getDatabase } from '@soroban-keeper-network/keeper-bot-v2';

async function keeperLoop(config: BotConfig): Promise<void> {
  const db = getDatabase(config.stateDbPath);
  // ^ Returns the same connection every time, no new connections created
  
  // Process tasks
  // Record outcomes
}

// In CLI inspection (separate process)
import { getDatabase } from '@soroban-keeper-network/keeper-bot-v2';

async function inspect(taskId: number): Promise<void> {
  const db = getDatabase(config.stateDbPath);
  // ^ Different process, opens the database file again
  // SQLite allows concurrent readers
}
```

## Recording Task Outcomes

When the keeper claims, executes, or expires a task, record the outcome:

```typescript
import { recordTaskOutcome } from '@soroban-keeper-network/keeper-bot-v2';
import { Keypair } from '@stellar/stellar-sdk';

const keypair = Keypair.fromSecret(config.secretKey);

async function keeperLoop(db: Database.Database): Promise<void> {
  for (const task of tasks) {
    try {
      // Step 1: Claim
      await client.claimTask({ keeper: keypair.publicKey(), taskId: task.taskId });
      recordTaskOutcome(db, task.taskId, keypair.publicKey(), 'claimed', 'success');

      // Step 2: Execute
      const proof = await generateProof(task);
      await client.executeTask({
        keeper: keypair.publicKey(),
        taskId: task.taskId,
        proof,
      });
      recordTaskOutcome(
        db,
        task.taskId,
        keypair.publicKey(),
        'executed',
        `proof: ${proof.toString('hex').slice(0, 20)}...`,
      );

      // Step 3: or Expire
    } catch (err) {
      if (isDeadlinePassed(task)) {
        await client.expireTask({ keeper: keypair.publicKey(), taskId: task.taskId });
        recordTaskOutcome(db, task.taskId, keypair.publicKey(), 'expired', 'success');
      }
    }
  }
}
```

## Recording Skip Decisions

When the keeper skips a task (for any reason), record why:

```typescript
import { recordSkipDecision, SkipReason } from '@soroban-keeper-network/keeper-bot-v2';

async function keeperLoop(db: Database.Database): Promise<void> {
  for (const task of tasks) {
    // Check deadline
    if (isDeadlinePassed(task)) {
      recordSkipDecision(db, task.taskId, SkipReason.DEADLINE_PASSED, {
        deadline: task.deadline,
        current_time: Math.floor(Date.now() / 1000),
      });
      continue;
    }

    // Check profitability
    const profitCheck = await checkProfitability(task);
    if (!profitCheck.profitable) {
      recordSkipDecision(db, task.taskId, SkipReason.UNPROFITABLE, {
        reward: task.reward,
        estimated_gas: profitCheck.estimatedGas,
        margin: config.minProfitMarginStroops,
      });
      continue;
    }

    // Check executor availability
    const executor = getExecutor(task.taskType);
    if (!executor) {
      recordSkipDecision(db, task.taskId, SkipReason.NO_EXECUTOR, {
        task_type: task.taskTypeName,
      });
      continue;
    }

    // Check verifier support
    const verifier = getVerifier(task.verifierType);
    if (!verifier) {
      recordSkipDecision(db, task.taskId, SkipReason.UNSUPPORTED_VERIFIER, {
        verifier: task.verifierType,
      });
      continue;
    }

    // Try to generate proof
    try {
      const proof = await executor.execute(task);
      if (!proof) {
        recordSkipDecision(db, task.taskId, SkipReason.PROOF_GENERATION_FAILED, {
          task_type: task.taskTypeName,
          error: 'executor returned null',
        });
        continue;
      }
    } catch (err) {
      recordSkipDecision(db, task.taskId, SkipReason.PROOF_GENERATION_FAILED, {
        task_type: task.taskTypeName,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    // Try to claim
    try {
      await client.claimTask({ keeper: keypair.publicKey(), taskId: task.taskId });
      recordTaskOutcome(db, task.taskId, keypair.publicKey(), 'claimed');
    } catch (err) {
      if (isPermanentError(err)) {
        recordSkipDecision(db, task.taskId, SkipReason.CLAIM_RACE_LOST, {
          error: err instanceof Error ? err.message : String(err),
        });
      } else {
        recordSkipDecision(db, task.taskId, SkipReason.OTHER_ERROR, {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      continue;
    }

    // Continue with execution...
  }
}
```

## Skip Reason Codes Reference

All available skip reason codes:

```typescript
export enum SkipReason {
  DEADLINE_PASSED = 'deadline_passed',
  UNPROFITABLE = 'unprofitable',
  NO_EXECUTOR = 'no_executor',
  UNSUPPORTED_VERIFIER = 'unsupported_verifier',
  PROOF_GENERATION_FAILED = 'proof_generation_failed',
  CLAIM_RACE_LOST = 'claim_race_lost',
  SIMULATION_FAILED = 'simulation_failed',
  OTHER_ERROR = 'other_error',
}
```

**When to use each:**

- `DEADLINE_PASSED` — Task deadline has been exceeded
- `UNPROFITABLE` — Reward < estimated gas costs + margin
- `NO_EXECUTOR` — No executor registered for task type
- `UNSUPPORTED_VERIFIER` — Verifier not supported or not available
- `PROOF_GENERATION_FAILED` — Executor couldn't generate proof
- `CLAIM_RACE_LOST` — Another keeper claimed first (permanent error)
- `SIMULATION_FAILED` — Transaction simulation failed during verification
- `OTHER_ERROR` — Any other error (fallback)

## Inspection in Production

### Operator Workflow

```bash
# Check why a specific task was skipped
$ keeper-bot inspect task 42
# Returns: claimed, executed, expired, or unknown

$ keeper-bot inspect skip-decisions --task-id 42
# Returns: reasons this task was skipped

# Verify configuration is correct
$ keeper-bot inspect config
# Returns: current settings with secrets redacted

# Monitor skip patterns
$ keeper-bot inspect skip-decisions --limit 1000 --stats
# Returns: breakdown of recent skip reasons
```

### Automated Monitoring

Inspection output can be integrated with observability systems:

```typescript
async function collectMetrics(): Promise<void> {
  const db = getDatabase(config.stateDbPath);
  
  // Export skip reason stats
  const stats = getSkipReasonStats(db, 1000);
  for (const [reason, count] of Object.entries(stats)) {
    prometheus.gauge('keeper_skip_reason_count', { reason }, count);
  }
}
```

## Testing Integration

### Unit Tests for Keeper Loop

When writing tests for the keeper loop, use the test database:

```typescript
import { reinitializeDatabase } from '@soroban-keeper-network/keeper-bot-v2';

describe('Keeper Loop', () => {
  let db: Database.Database;

  beforeEach(() => {
    // Create an in-memory or temporary database for testing
    db = reinitializeDatabase(':memory:');
  });

  it('records claimed task outcome', async () => {
    // Run keeper loop
    await keeperLoop(db, testConfig);

    // Verify outcome was recorded
    const outcome = getTaskOutcome(db, 42);
    expect(outcome?.action).toBe('claimed');
  });

  it('records skip reason for unprofitable task', async () => {
    // Configure an unprofitable task scenario
    // Run keeper loop
    // Verify skip decision was recorded
    const decisions = getSkipDecisionsForTask(db, 42);
    expect(decisions).toContainEqual(
      expect.objectContaining({ reason: SkipReason.UNPROFITABLE })
    );
  });
});
```

## Performance Considerations

### Database Write Performance

Task outcomes and skip decisions are written on every task interaction:

```typescript
// Every claim:
recordTaskOutcome(db, taskId, keeper, 'claimed');  // ~1-2ms

// Every skip:
recordSkipDecision(db, taskId, reason, info);      // ~1-2ms

// Expected: ~100 tasks/round × 1ms write = ~100ms overhead
// This is acceptable for a ~10 second polling interval
```

### Database Query Performance

Inspection queries run synchronously (no async I/O):

```typescript
// Inspection queries (indexes used):
getTaskOutcome(db, taskId);                        // ~0.1ms (primary key)
getRecentSkipDecisions(db, 100);                   // ~0.5ms (timestamp index)
getSkipReasonStats(db, 1000);                      // ~1-2ms (aggregation)
```

### Concurrency

SQLite allows multiple readers concurrently:

```
Keeper Loop (writer)      Inspection CLI (reader)
    ↓                              ↓
    └─────── SQLite DB ───────────┘
    
- Write-ahead logging (WAL) enabled
- One writer at a time (keeper loop)
- Many readers concurrently (inspection commands)
- No lock contention expected
```

## Future Enhancements

### Metrics Endpoint (Issue #0257)

The inspection infrastructure supports exposing metrics via HTTP:

```typescript
// Future: Expose inspection data as Prometheus metrics
import express from 'express';

app.get('/metrics', (req, res) => {
  const db = getDatabase(config.stateDbPath);
  const stats = getSkipReasonStats(db, 1000);
  
  // Format as Prometheus output
  res.set('Content-Type', 'text/plain');
  for (const [reason, count] of Object.entries(stats)) {
    res.write(`keeper_skip_reason_total{reason="${reason}"} ${count}\n`);
  }
  res.end();
});
```

### Admin Interface (Potential Future)

The inspection commands could be exposed as admin API endpoints:

```typescript
app.get('/admin/inspect/task/:id', async (req, res) => {
  const db = getDatabase(config.stateDbPath);
  const result = inspectTask(db, parseInt(req.params.id));
  res.json(result);
});

app.get('/admin/inspect/config', async (req, res) => {
  const result = inspectConfig(config, keypair.publicKey());
  res.json(result);
});

app.get('/admin/inspect/skip-decisions', async (req, res) => {
  const db = getDatabase(config.stateDbPath);
  const limit = parseInt(req.query.limit || '100');
  const result = inspectSkipDecisions(db, limit, true);
  res.json(result);
});
```

### Alerting Integration (Potential Future)

Alert operators when skip reasons spike:

```typescript
async function checkSkipAnomalies(): Promise<void> {
  const db = getDatabase(config.stateDbPath);
  const stats = getSkipReasonStats(db, 1000);
  
  // Alert if unprofitable tasks spike
  if (stats.unprofitable > stats.deadline_passed * 2) {
    alerting.warn('Unusual increase in unprofitable tasks');
  }
  
  // Alert if claim_race_lost spikes
  if (stats.claim_race_lost > 100) {
    alerting.warn('High rate of claim race losses (competing keepers?)');
  }
}
```

## See Also

- [INSPECTION.md](./INSPECTION.md) — Operator guide
- [SECURITY_REVIEW.md](./SECURITY_REVIEW.md) — Security analysis
- [README.md](./README.md) — Quick start
- [../examples/keeper-bot](../../examples/keeper-bot) — v1 reference implementation
