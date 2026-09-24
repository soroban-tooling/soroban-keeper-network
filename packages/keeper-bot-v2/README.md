# Keeper Bot v2

Production-ready keeper bot for the Soroban Keeper Network, featuring:

- **External Secret Manager Support**: Load signing keys from AWS Secrets Manager or environment variables
- **Graceful RPC Degradation**: Continue operations during extended RPC outages with automatic recovery
- **Persistent Task State**: Prevent double-claiming with durable task state tracking
- **Concurrent Task Processing**: Process multiple tasks within a round with resource budgets
- **Pluggable Alerting**: Notifications on missed executions and persistent errors
- **Redaction Discipline**: No signing key material ever appears in logs or error messages

**⚠️ v2 is aimed at operators running keepers competitively. For newcomers, see `examples/keeper-bot` (v1) instead.**

## Installation

```bash
npm install @soroban-keeper-network/keeper-bot-v2
```

## Getting Started

```bash
cp .env.example .env
npm run build
npm start
```

## Configuration

### Secret Management

#### Using Environment Variables (Default)

The simplest setup for local development:

```bash
export KEEPER_SECRET_KEY=S...  # Your Stellar Ed25519 secret seed
```

```typescript
import { createSecretSource } from "@soroban-keeper-network/keeper-bot-v2";

const source = createSecretSource();
const keypair = await source.getSigningKey();
```

#### Using AWS Secrets Manager

For production deployments:

```bash
export SECRET_SOURCE=aws-secrets-manager
export AWS_SECRET_NAME=my-keeper-secret
export AWS_REGION=us-east-1
```

First install the AWS SDK:
```bash
npm install @aws-sdk/client-secrets-manager
```

#### Environment Variables

##### `SECRET_SOURCE` (optional)
- Default: `env`
- Values: `env`, `aws-secrets-manager`
- Controls which secret source is used

##### For `SECRET_SOURCE=env`
- `KEEPER_SECRET_KEY` (or custom via `KEEPER_SECRET_KEY_ENV_VAR`)
- Must be a valid Stellar Ed25519 secret seed (starts with `S`)

##### For `SECRET_SOURCE=aws-secrets-manager`
- `AWS_SECRET_NAME` (required): The secret name in AWS Secrets Manager
- `AWS_REGION` (optional): AWS region where the secret is stored (default: `us-east-1`)

##### Degraded Mode Settings
- `CONSECUTIVE_EXHAUSTED_RETRIES_FOR_DEGRADED_MODE`: Threshold for entering degraded mode (default: 3)
- `DEGRADED_MODE_POLLING_INTERVAL_MS`: Polling interval during RPC outages (default: 60000)

See `.env.example` for all available configuration options.

### Programmatic Configuration

```typescript
import {
  createSecretSource,
  SecretSourceConfig,
  loadConfig,
  KeeperLoop,
} from "@soroban-keeper-network/keeper-bot-v2";

// Environment variable source
const envConfig: SecretSourceConfig = {
  type: "env",
  envVar: "KEEPER_SECRET_KEY", // optional, defaults to KEEPER_SECRET_KEY
};

// AWS Secrets Manager source
const awsConfig: SecretSourceConfig = {
  type: "aws-secrets-manager",
  secretName: "my-keeper-secret",
  region: "us-east-1", // optional
};

const secretSource = createSecretSource(envConfig);
const keypair = await secretSource.getSigningKey();

// Load full bot configuration
const config = loadConfig();
const loop = new KeeperLoop(config);
```

## Features

### Security & Secret Management

This package applies redaction discipline to prevent accidental exposure of signing keys:

- **No raw secrets in logs**: The signing key never appears in console output, error messages, or debug representations
- **No secrets in errors**: Errors include only the source description (e.g., "environment variable KEEPER_SECRET_KEY"), not the actual key
- **Error cause chains scrubbed**: AWS Secrets Manager error responses are sanitized
- **Configuration is safe**: Config objects never contain actual secrets — only source specifications

### Graceful RPC Degradation

The bot continues to function during RPC outages:

- Automatically detects failed RPC calls via exhausted retry logic
- Enters degraded mode with reduced polling frequency
- Maintains persistent task state to prevent double-claiming
- Recovers automatically when RPC becomes available
- Emits alerts for monitoring and debugging

### Persistent Task State

Keeps track of processed tasks across restarts:

- Prevents duplicate task execution
- Survives bot restarts and network interruptions
- Configurable state backend (default: in-memory with optional persistence layer)

### Concurrent Task Processing

Process multiple tasks in a single round:

- Configurable resource budgets (CPU, memory)
- Parallel execution with safety guarantees
- Automatic backpressure handling

## Production Recommendations

1. **Use AWS Secrets Manager** for real funds deployments, not plain environment variables
2. **Rotate secrets regularly** using AWS Secrets Manager's rotation features
3. **Monitor access** to secrets via AWS CloudTrail
4. **Use IAM roles** rather than long-lived access keys
5. **Never commit secrets** to version control — use `.gitignore` for `.env` files
6. **Configure alerts** for monitoring missed executions
7. **Monitor RPC health** to respond quickly to outages

## API

### `createSecretSource(config?: SecretSourceConfig): SecretSource`

Creates a SecretSource from configuration.

**Parameters:**
- `config` (optional): Explicit configuration object. If omitted, reads from environment variables.

**Returns:** A SecretSource instance (EnvSecretSource or AwsSecretsManagerSource)

**Throws:** `SecretSourceError` if configuration is invalid

**Example:**
```typescript
const source = createSecretSource({ type: "env" });
const keypair = await source.getSigningKey();
```

### `validateSecretSourceStartup(config?: SecretSourceConfig): Promise<void>`

Validates that a secret source is reachable and correctly configured.

**Parameters:**
- `config` (optional): Explicit configuration, or undefined to read from environment

**Throws:** `SecretSourceError` if the source is misconfigured or unreachable

**Example:**
```typescript
import { validateSecretSourceStartup } from "@soroban-keeper-network/keeper-bot-v2";

try {
  await validateSecretSourceStartup();
  console.log("Secret source validated successfully");
} catch (err) {
  console.error("Secret source configuration error:", err.message);
  process.exit(1);
}
```

### `KeeperLoop` Class

Main loop for keeper operations with degraded mode support.

**Example:**
```typescript
import { KeeperLoop, loadConfig } from "@soroban-keeper-network/keeper-bot-v2";

const config = loadConfig();
const loop = new KeeperLoop(config);
await loop.run();
```

### `loadConfig(): Config`

Loads configuration from environment variables.

### `simulateRound(): Promise<void>`

Simulates a single keeper round for testing and validation.

## Testing

Run the test suite:

```bash
npm test
```

The test suite includes:
- Unit tests for secret sources and configuration
- Redaction tests asserting secrets never appear in errors or logs
- Degraded mode and RPC recovery tests
- Concurrent task processing tests
- Integration tests

## Development

```bash
npm run build     # Compile TypeScript
npm run lint      # Check code style
npm test          # Run test suite
npm start         # Start the bot
```

## License

Apache License 2.0
