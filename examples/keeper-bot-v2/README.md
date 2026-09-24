# Soroban Keeper Bot v2

Production-grade keeper bot for the Soroban Keeper Network with persistence, concurrency, metrics collection, and alerting.

## Overview

This is the v2 implementation of the keeper bot, designed for production use with:

- **Persistence** (issue 0252): Durable task state tracking
- **Concurrency** (issue 0253): Parallel task processing
- **Metrics** (issue 0257): Operational observability
- **Alerting** (issue 0258): Missed execution and error detection

## Current Implementation: Alerting System

This package includes a complete alerting system for monitoring keeper bot operations.

### Quick Start

```typescript
import { createAlertManager, KeeperMetrics } from "./src/alerts";

// Create alert manager with webhook transport
const manager = createAlertManager({
  webhook: {
    url: "https://your-alerting-service.com/alerts",
    headers: { Authorization: "Bearer your-token" },
  },
  missedExecution: { lockWindowMs: 60000 },
  consecutiveRpcErrors: { threshold: 3 },
  stagnantBalance: { enabled: true },
});

// Evaluate metrics in your keeper loop
const metrics: KeeperMetrics = {
  claimedTasks: new Map([
    ["task-1", { claimedAt: new Date(), executed: true }],
  ]),
  consecutiveRpcErrors: 0,
  keeperBalance: 1000000n,
  previousKeeperBalance: 900000n,
  claimedActivityCount: 5,
  roundsWithRpcErrors: 0,
};

await manager.evaluate(metrics);
```

## Architecture

### Alert Transport

The alerting system uses a pluggable transport pattern:

```typescript
export interface AlertTransport {
  send(payload: AlertPayload): Promise<void>;
}
```

Implementations provided:
- **WebhookTransport**: Generic HTTP webhook with POST/PUT, custom headers, timeout
- **NoopTransport**: No-op for testing/disabled alerts

Custom transports can be added for:
- PagerDuty
- Slack
- Telegram
- Datadog
- Custom internal systems

### Alert Rules

Three built-in rules detect critical conditions:

#### 1. MissedExecutionRule
Detects when a claimed task is not executed within its lock window.

- **Incident ID**: `missed-execution:task-1,task-2,...` (sorted)
- **Severity**: critical
- **Metadata**: list of missed tasks, lock window duration

#### 2. ConsecutiveRpcErrorRule
Detects when consecutive rounds with RPC errors exceed a threshold.

- **Incident ID**: `consecutive-rpc-errors`
- **Severity**: critical
- **Metadata**: error count, threshold

#### 3. StagnantBalanceRule
Detects when the keeper balance is not growing despite claimed activity.

- **Incident ID**: `stagnant-balance`
- **Severity**: warning
- **Metadata**: current/previous balance, claimed activity count

### Deduplication

The AlertManager ensures exactly one notification per incident:

- Fires on first detection
- Suppresses duplicates while condition persists
- Clears incident when condition resolves
- Can re-fire if condition recurs

This prevents alert flooding while maintaining responsiveness.

## Development

### Build

```bash
npm run build
```

Compiles TypeScript to `dist/` directory.

### Test

```bash
npm test          # Run tests once
npm run test:watch # Run in watch mode
```

Tests cover:
- All three alert rules
- Deduplication logic
- Transport implementations
- Error resilience
- Configuration factory

### Lint

```bash
npm run lint
```

Validates code against repository style guidelines.

### Type Check

```bash
npm run type-check
```

Verifies TypeScript types without building.

## API Reference

### AlertManager

```typescript
class AlertManager {
  // Evaluate all rules against current metrics
  async evaluate(metrics: KeeperMetrics): Promise<void>
  
  // Get currently active incidents
  getActiveIncidents(): Set<string>
  
  // Clear an incident (for testing)
  clearIncident(incidentId: string): void
}
```

### Alert Rules

```typescript
interface AlertRule {
  id: string
  check(metrics: KeeperMetrics): AlertPayload | null
}

class MissedExecutionRule implements AlertRule
class ConsecutiveRpcErrorRule implements AlertRule
class StagnantBalanceRule implements AlertRule
```

### Configuration

```typescript
interface AlertConfig {
  webhook?: WebhookTransportConfig
  missedExecution?: { lockWindowMs: number }
  consecutiveRpcErrors?: { threshold: number }
  stagnantBalance?: { enabled: boolean }
}

function createAlertManager(config: AlertConfig): AlertManager
```

## Metrics Structure

```typescript
interface KeeperMetrics {
  // Map of claimed tasks with execution status
  claimedTasks: Map<string, { claimedAt: Date; executed: boolean }>
  
  // Consecutive rounds with RPC errors
  consecutiveRpcErrors: number
  
  // Current keeper balance (stroops)
  keeperBalance: bigint
  
  // Previous keeper balance (stroops)
  previousKeeperBalance: bigint
  
  // Number of tasks claimed in this round
  claimedActivityCount: number
  
  // Total rounds with RPC errors
  roundsWithRpcErrors: number
}
```

## Testing

The test suite includes 45+ tests covering:

- **Rule Logic**: Each rule's detection conditions and false negatives
- **Deduplication**: Exactly one alert per incident, re-triggering after clearing
- **Transport**: Webhook configuration, error handling, timeout behavior
- **Manager**: Rule evaluation, incident tracking, cleanup
- **Factory**: Configuration handling, transport selection, rule setup

Run tests with `npm test`.

## Related Issues

- **Issue 0257**: Metrics collection endpoint - provides the KeeperMetrics data
- **Issue 0240**: Indexer alert hooks - established the pluggable transport pattern
- **Issue 0252**: Task persistence - required for tracking claimed/executed status
- **Issue 0253**: Concurrent task processing - source of metrics for alerting

## Integration

To integrate this alerting system with keeper-bot-v2:

1. Collect metrics in your keeper loop (issue 0257)
2. Create an alert manager with your configuration
3. Call `manager.evaluate(metrics)` each round
4. Handle alert payloads in your transport implementation

Example integration:

```typescript
// In keeper bot loop
const manager = createAlertManager(config.alerts);

for (const round of keeperRounds) {
  const metrics = collectMetrics();  // from issue 0257
  await manager.evaluate(metrics);   // evaluate alerts
  // ... rest of keeper loop
}
```

## License

Apache-2.0

## References

- [GitHub Issue 0258](../../.github/backlog/issues/0258-bot-v2-alerting.md)
- [Issue 0257: Metrics Endpoint](../../.github/backlog/issues/0257-bot-v2-metrics-endpoint.md)
- [Issue 0240: Indexer Alert Hooks](../../.github/backlog/issues/0240-indexer-alerting-hooks.md)
