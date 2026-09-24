# Keeper Bot v2

A production-ready keeper bot for the Soroban Keeper Network. This is **not** the beginner-friendly example; see `examples/keeper-bot` for that.

v2 is aimed at operators running a keeper competitively, with features v1 lacks:

- **Persistent state**: Task outcomes survive process restarts (issue #0252)
- **Concurrency**: Process multiple tasks in a single round (issue #0253)
- **Profitability checks**: Only claim tasks that are worth the gas (issue #0254)
- **Database-backed storage**: PostgreSQL persistence for task state
- **Pluggable executors**: Richer, discoverable executor interface (issue #0256)

## Quick Start

### Local Development (Daemon Mode)

```bash
cd examples/keeper-bot-v2

# Copy and customize configuration
cp .env.example .env
# Edit .env with your KEEPER_SECRET_KEY, REGISTRY_CONTRACT_ID, and DB credentials

# Start the deployment (keeper-bot + PostgreSQL)
docker-compose up -d

# View logs
docker-compose logs -f keeper-bot

# Stop
docker-compose down
```

### One-Shot Mode (Cron / Serverless)

```bash
# Run a single round then exit
RUN_ONCE=true docker-compose run --rm keeper-bot
```

## Configuration

All configuration is loaded from environment variables. See `.env.example` for the complete list and defaults.

### Required Variables

| Variable | Description | Example |
|----------|-------------|---------|
| `KEEPER_SECRET_KEY` | Stellar secret key (starts with S) | `SBXXXXXXX...` |
| `REGISTRY_CONTRACT_ID` | KeeperRegistry contract ID (starts with C) | `CAXXXXXX...` |
| `NETWORK` | Stellar network | `testnet` (or `futurenet`, `mainnet`) |
| `DATABASE_URL` | PostgreSQL connection string | `postgresql://user:pass@host:5432/keeper_bot` |

### Optional Variables (with Defaults)

| Variable | Default | Description |
|----------|---------|-------------|
| `POLL_INTERVAL_MS` | 10000 | Polling frequency (milliseconds) |
| `WITHDRAW_THRESHOLD` | 10000000 | Minimum accumulated rewards before withdrawal (stroops; 1 XLM = 10M stroops) |
| `MAX_TASKS_PER_ROUND` | 5 | Maximum tasks to process per round |
| `MAX_RETRIES` | 3 | Retry attempts for transient errors |
| `RETRY_BASE_MS` | 500 | Base delay for exponential backoff (milliseconds) |
| `EXPIRE_STALE_TASKS` | true | Whether to expire past-deadline tasks |
| `MIN_PROFIT_MARGIN_STROOPS` | 0 | Minimum profit margin to claim a task (stroops) |
| `SIMULATE_EXECUTION` | false | [Dev only] Fabricate proofs instead of calling executor |
| `RUN_ONCE` | false | [Dev only] One-shot mode; exit after single round |

## Secret Handling

**Secrets are never baked into the image.** All sensitive configuration is supplied at runtime via environment variables or `.env` file.

### Security Best Practices

1. **Never commit `.env`**: Ensure `.gitignore` includes `.env`
2. **Restrict file permissions**: `chmod 600 .env`
3. **Use a secrets manager in production**: 
   - For Kubernetes: use Secrets
   - For Docker Swarm: use Secrets
   - For AWS: use AWS Secrets Manager
   - For other platforms: inject via your orchestration tool
4. **Validate before logging**: Configuration validation never includes secret values in error messages

Example error output (safe to log):
```
Invalid KEEPER_SECRET_KEY — must be a valid Stellar secret seed (starts with S)
```

Notice: the actual key is never shown, only the variable name and reason.

## Database

keeper-bot-v2 requires PostgreSQL for persistent state. The compose example includes a PostgreSQL service, but you can use any PostgreSQL instance:

```bash
# Use a managed PostgreSQL service (e.g., AWS RDS, DigitalOcean, Heroku)
docker run \
  -e DATABASE_URL='postgresql://user:pass@my-db.example.com:5432/keeper' \
  -e KEEPER_SECRET_KEY='...' \
  -e REGISTRY_CONTRACT_ID='...' \
  -e NETWORK='testnet' \
  keeper-bot-v2:latest
```

### Schema Migrations

On first run, the bot applies pending migrations automatically. This allows a fresh database to be set up with a single command:

```bash
# Brings a fresh database to the current schema
docker-compose up -d keeper-bot
```

Migrations are idempotent: running the bot against an already-migrated database is safe.

## Deployment Topologies

### Docker Compose (Development / Small Operators)

See `docker-compose.yml` for a complete example with PostgreSQL.

```bash
docker-compose up -d
docker-compose down
docker-compose down -v  # Destroy persisted data
```

### Kubernetes (Production / Enterprise)

Use the Dockerfile with a Helm chart or Kustomize overlays:

```bash
docker build -t keeper-bot-v2:latest .
docker tag keeper-bot-v2:latest your-registry/keeper-bot-v2:latest
docker push your-registry/keeper-bot-v2:latest
```

Then deploy via your orchestration tool, using Kubernetes Secrets for sensitive config:

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: keeper-bot-secrets
type: Opaque
stringData:
  KEEPER_SECRET_KEY: SBXXXXXXX...
  DATABASE_URL: postgresql://user:pass@postgres:5432/keeper

---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: keeper-bot
spec:
  template:
    spec:
      containers:
      - name: keeper-bot
        image: your-registry/keeper-bot-v2:latest
        envFrom:
        - secretRef:
            name: keeper-bot-secrets
        env:
        - name: REGISTRY_CONTRACT_ID
          value: CAXXXXXX...
        - name: NETWORK
          value: testnet
```

### AWS ECS (Fargate / EC2)

Register a task definition with secrets stored in AWS Secrets Manager:

```json
{
  "family": "keeper-bot-v2",
  "containerDefinitions": [
    {
      "name": "keeper-bot",
      "image": "your-account.dkr.ecr.us-east-1.amazonaws.com/keeper-bot-v2:latest",
      "secrets": [
        {
          "name": "KEEPER_SECRET_KEY",
          "valueFrom": "arn:aws:secretsmanager:us-east-1:123456789:secret:keeper-bot/secret-key"
        },
        {
          "name": "DATABASE_URL",
          "valueFrom": "arn:aws:secretsmanager:us-east-1:123456789:secret:keeper-bot/db-url"
        }
      ],
      "environment": [
        { "name": "REGISTRY_CONTRACT_ID", "value": "CAXXXXXX..." },
        { "name": "NETWORK", "value": "testnet" }
      ]
    }
  ]
}
```

## Graceful Shutdown

The bot listens for `SIGINT` and `SIGTERM`, completing the current round before exiting. When using containers or orchestration:

- Set a reasonable stop timeout: `docker run --stop-timeout 30 ...`
- Configure Pod termination grace period: `terminationGracePeriodSeconds: 30`
- The bot logs "finishing current round then exiting..." on shutdown

## Monitoring and Observability

### Exit Codes

- **0**: Success (one-shot mode) or graceful shutdown
- **1**: Configuration error (missing required variable, invalid value) or runtime error
- **Other**: Unexpected failure

### Logs

All activity is logged to stdout/stderr:

```bash
docker-compose logs keeper-bot
docker-compose logs -f keeper-bot  # Follow
```

Typical log output:

```
Soroban Keeper Network — Keeper Bot v2

  Network  : testnet
  RPC URL  : https://soroban-testnet.stellar.org
  Keeper   : GXXXXXXX...
  Registry : CXXXXXXX...
  Mode     : Poll: every 10s
  Withdraw : when balance ≥ 10000000 stroops

RPC healthy — ledger 1234567

Keeper round at 2024-10-20T12:34:56.789Z
  Found 5 TaskRegistered events to evaluate
  Attempting to claim task 1 (reward: 1000000)...
  Task 1 claimed!
  ...
```

### Metrics

In production, integrate with monitoring tools:

- **Prometheus**: Scrape metrics endpoint (future feature, issue #0257)
- **CloudWatch**: Stream logs to AWS CloudWatch
- **Datadog**: Use log forwarding
- **Custom alerting**: Parse stdout/stderr for `ERROR` or `WARN` prefixes

## Build and Image Details

### Build Command

```bash
docker build -t keeper-bot-v2:latest .
```

### Image Size

The final runtime image is approximately 200–250 MiB (Node.js 20 Alpine + dependencies).

### Base Image

**Runtime**: `node:20-alpine` — Small, security-focused base with Node.js 20 LTS.

### Security

- **Non-root user**: Runs as `keeper:keeper` (uid 1000:1000)
- **No secrets embedded**: All config is runtime-injected
- **Minimal dependencies**: Only production npm dependencies included
- **Health checks**: PostgreSQL health check in compose example

## Development and Contributing

This directory contains the production keeper bot. For contributions:

1. Follow the patterns established in `examples/keeper-bot` (v1)
2. Ensure configuration validation matches v1's `requireEnv()` discipline
3. Never log secret values
4. Test database migrations on a fresh database
5. Update `.env.example` if adding new environment variables

## References

- [Keeper Network Design](../../docs/ARCHITECTURE.md)
- [Keeper Bot v2 Design](../../docs/KEEPER_BOT_V2_DESIGN.md) (when written; issue #0250)
- [Deployment Guide](../../docs/DEPLOYING.md)
- [Indexer Design](../../docs/INDEXER_DESIGN.md) (database patterns)
- Issue #0267: Container image and docker-compose example (this work)
- Issue #0252: Persistent state schema (v2 database feature)

## License

Apache 2.0 — Same as the rest of the soroban-keeper-network repository.
