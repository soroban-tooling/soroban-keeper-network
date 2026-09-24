# Keeper Bot v2: Comprehensive Feature Integration

## Overview

This PR merges four interconnected features for the Soroban Keeper Network v2 bot, establishing a production-ready foundation with enterprise-grade reliability and security.

## Resolved Issues

Closes #396, #387, #380, #381

### #396: Support External Secret Managers for the Signing Key

Implements pluggable secret source abstraction with support for:
- **Environment variable source**: Local development simplicity with `KEEPER_SECRET_KEY`
- **AWS Secrets Manager**: Production-grade secret management with rotation and audit trails

Key features:
- Redaction discipline: No signing key material in logs or error messages
- Type-safe configuration with explicit `SECRET_SOURCE` selection
- Lazy-loading of AWS SDK (only when AWS source is used)
- Comprehensive validation and error handling

### #387: Degrade Gracefully During Extended RPC Outage

Implements automatic degradation mode for RPC reliability:
- Detects failed RPC calls through exhausted retry logic
- Enters degraded mode with reduced polling frequency
- Maintains persistent task state to prevent double-claiming
- Automatic recovery when RPC becomes available
- Pluggable alerting for monitoring and debugging

### #380: Persistent Task-State Schema

Adds durable task state tracking to prevent duplicate executions:
- Persistent storage layer for processed tasks
- Survives bot restarts and network interruptions
- Configurable backends (default: in-memory with optional persistence)
- Critical for competitive keeper environments

### #381: Process Multiple Tasks Concurrently Within a Round

Enables parallel task execution with safety guarantees:
- Configurable resource budgets (CPU, memory)
- Concurrent processing within keeper rounds
- Automatic backpressure handling
- Prevents resource exhaustion while maximizing throughput

## Changes

### New Files

- `packages/keeper-bot-v2/src/secrets/` - Secret source implementations
  - `env-source.ts` - Environment variable secret source
  - `aws-source.ts` - AWS Secrets Manager integration
  - `types.ts` - Secret source interfaces and types
  - `factory.ts` - Secret source factory and configuration
  - Comprehensive test coverage for all components

- `packages/keeper-bot-v2/src/` - Core bot functionality
  - `loop.ts` - Main keeper loop with degraded mode support
  - `config.ts` - Configuration loading from environment
  - `types.ts` - Core types and interfaces
  - `alerts.ts` - Pluggable alerting system
  - Extensive test coverage for all features

### Modified Files

- `packages/keeper-bot-v2/package.json` - Combined dependencies and exports
- `packages/keeper-bot-v2/src/index.ts` - Unified exports for secrets and loop
- `packages/keeper-bot-v2/vitest.config.ts` - Enhanced test configuration
- `packages/keeper-bot-v2/README.md` - Comprehensive documentation

### Configuration

New environment variables:
- `SECRET_SOURCE` - Secret source type (`env` or `aws-secrets-manager`)
- `KEEPER_SECRET_KEY` - Environment variable secret source
- `AWS_SECRET_NAME` - AWS Secrets Manager secret name
- `AWS_REGION` - AWS region for secrets
- `CONSECUTIVE_EXHAUSTED_RETRIES_FOR_DEGRADED_MODE` - Degradation threshold
- `DEGRADED_MODE_POLLING_INTERVAL_MS` - Polling interval during outages

## Architecture Highlights

### Secret Management

```
KeeperBot
    ↓
createSecretSource()
    ↓
    ├─ EnvSecretSource (KEEPER_SECRET_KEY)
    └─ AwsSecretsManagerSource (AWS_SECRET_NAME)
```

### Graceful RPC Degradation

```
Normal Mode
    ↓
(RPC failures) → Consecutive exhausted retries
    ↓
Degraded Mode (reduced polling)
    ↓
(RPC recovery) → Resume normal operations
```

### Task State & Concurrent Processing

- Persistent state prevents double-claiming
- Concurrent processing with resource budgets
- Safe parallel execution within keeper rounds

## Testing

All features include comprehensive test coverage:

- **Secret management tests**: Configuration, validation, redaction verification
- **Degraded mode tests**: RPC failure detection, state persistence, recovery
- **Concurrent processing tests**: Resource budgets, backpressure handling
- **Integration tests**: End-to-end keeper loop scenarios
- **Redaction discipline tests**: Verify secrets never leak in errors or logs

Run tests with: `npm test`

## Documentation

- Updated README.md with feature descriptions and usage examples
- Inline code comments for complex logic
- Environment variable reference in `.env.example`
- API documentation for main exports

## Production Readiness

This release establishes a production-ready keeper with:

✅ Enterprise secret management (AWS Secrets Manager support)
✅ RPC reliability (graceful degradation and recovery)
✅ Safety guarantees (persistent task state, redaction discipline)
✅ Performance optimization (concurrent task processing)
✅ Operational observability (pluggable alerting)

### Recommendations for Operators

1. Use AWS Secrets Manager for real funds deployments
2. Configure alerts for monitoring
3. Set appropriate degraded mode thresholds
4. Monitor RPC health and response times
5. Enable persistent state backend for durability

## Migration Notes

For existing keeper-bot deployments:

- Configuration moved to environment variables (see `.env.example`)
- Secret source must be explicitly specified via `SECRET_SOURCE`
- New optional dependencies: `@aws-sdk/client-secrets-manager` (for AWS source)
- Database schema updates required (if upgrading from v1)

## Related Documentation

See README.md for:
- Quick start guide
- Configuration reference
- API documentation
- Security best practices
- Development setup

---

**Type**: Feature
**Scope**: keeper-bot-v2
**Breaking Changes**: Yes (configuration and API)
**Tested**: Yes (comprehensive test suite)
**Documented**: Yes (README and inline comments)
