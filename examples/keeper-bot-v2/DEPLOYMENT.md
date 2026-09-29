# Keeper Bot v2 Deployment Guide

This document details how configuration flows from the container runtime through to the keeper application at runtime, and how to deploy keeper-bot-v2 in various environments.

## Configuration Flow

### Path: Container Runtime → Application Runtime

```
┌─────────────────────────────────────────────────────────────┐
│ Container Runtime                                           │
│  (Docker, Kubernetes, ECS, etc.)                            │
└───────────────────┬─────────────────────────────────────────┘
                    │
      docker run -e KEEPER_SECRET_KEY='...' \
                 -e REGISTRY_CONTRACT_ID='...' \
                 -e DATABASE_URL='...' \
                 --env-file .env \
                 keeper-bot-v2:latest
                    │
                    ▼
┌─────────────────────────────────────────────────────────────┐
│ Container Environment                                       │
│  process.env.KEEPER_SECRET_KEY                              │
│  process.env.REGISTRY_CONTRACT_ID                           │
│  process.env.DATABASE_URL                                   │
│  process.env.NETWORK                                        │
│  process.env.POLL_INTERVAL_MS                               │
│  ... (all optional vars)                                    │
└───────────────────┬─────────────────────────────────────────┘
                    │
    docker run → CMD ["node", "index.js"]
                    │
                    ▼
┌─────────────────────────────────────────────────────────────┐
│ Node.js Process Startup (index.js)                          │
│                                                              │
│  1. require("dotenv").config()                              │
│     Loads .env file if present (used for local dev)         │
│                                                              │
│  2. validateAndLoadConfig()                                 │
│     • Call requireEnv() for each config variable            │
│     • Validate types (parse integers, parse booleans)       │
│     • Validate ranges (e.g., POLL_INTERVAL_MS >= 1000)      │
│     • Validate formats (StrKey for KEEPER_SECRET_KEY)       │
│     • Exit process if validation fails (error logged,       │
│       but secret values suppressed)                         │
│     • Return CONFIG object with validated values            │
│                                                              │
│  3. CONFIG.secretKey                                        │
│     Parsed Stellar secret key (StrKey format)               │
│                                                              │
│  4. CONFIG.registryContractId                               │
│     Parsed contract ID (StrKey format)                      │
│                                                              │
│  5. CONFIG.network                                          │
│     Validated network name (testnet/futurenet/mainnet)      │
│                                                              │
│  6. CONFIG.databaseUrl                                      │
│     PostgreSQL connection string (e.g., postgresql://...)   │
└───────────────────┬─────────────────────────────────────────┘
                    │
                    ▼
┌─────────────────────────────────────────────────────────────┐
│ Keeper Application Runtime (keeperLoop)                    │
│                                                              │
│  • Create Keypair from CONFIG.secretKey                     │
│  • Create KeeperRegistryClient with CONFIG.registryContractId │
│  • Connect to RPC via NETWORK_PRESETS[CONFIG.network]       │
│  • Connect to PostgreSQL via CONFIG.databaseUrl             │
│  • Load task state from database                            │
│  • Poll for new tasks every CONFIG.pollIntervalMs           │
│  • Claim/execute tasks                                      │
│  • Persist outcomes to database                             │
│  • Withdraw rewards when balance >= CONFIG.withdrawThreshold │
└─────────────────────────────────────────────────────────────┘
```

## Configuration Variables: Source → Validation → Usage

### Required Variables

#### KEEPER_SECRET_KEY
- **Source**: Environment variable or `.env` file
- **Validation**: `requireEnv("KEEPER_SECRET_KEY", { secret: true, parse: (raw) => raw, validate: { fn: (v) => StrKey.isValidEd25519SecretSeed(v), reason: "must be a valid Stellar secret seed (starts with S)" } })`
- **Never logged**: Error messages say `Invalid KEEPER_SECRET_KEY — ...` without showing the value
- **Usage**: `Keypair.fromSecret(CONFIG.secretKey)` → used for signing transactions
- **Example**: `SBXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX`

#### REGISTRY_CONTRACT_ID
- **Source**: Environment variable or `.env` file
- **Validation**: `StrKey.isValidContract(value)`
- **Failure**: `Invalid REGISTRY_CONTRACT_ID — must be a valid Stellar contract ID (starts with C)`
- **Usage**: Passed to `KeeperRegistryClient(registryContractId, ...)`
- **Example**: `CAXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX`

#### NETWORK
- **Source**: Environment variable or `.env` file, or default: `testnet`
- **Validation**: `NETWORK_NAMES.includes(value)` (must be testnet/futurenet/mainnet)
- **Failure**: `Invalid NETWORK — must be one of: testnet, futurenet, mainnet`
- **Usage**: `NETWORK_PRESETS[CONFIG.network]` → provides `{ rpcUrl, networkPassphrase }`
- **Example**: `testnet`

#### DATABASE_URL
- **Source**: Environment variable or `.env` file (no default; required)
- **Validation**: Must be a valid PostgreSQL connection string (parsed by pg client)
- **Failure**: Connection error if malformed or unreachable
- **Usage**: Passed to PostgreSQL client for task-state persistence
- **Format**: `postgresql://[user[:password]@][host][:port][/dbname][?param=value]`
- **Example**: `postgresql://keeper:mypassword@postgres:5432/keeper_bot`
- **Compose**: Auto-constructed as `postgresql://${DB_USER}:${DB_PASSWORD}@postgres:5432/${DB_NAME}`

### Optional Variables (with Defaults)

#### POLL_INTERVAL_MS
- **Source**: Environment variable or `.env` file
- **Default**: `10000`
- **Validation**: Integer >= 1000
- **Failure**: `Invalid POLL_INTERVAL_MS — must be at least 1000 milliseconds`
- **Usage**: `setInterval(() => keeperLoop(), CONFIG.pollIntervalMs)`
- **Example**: `10000`

#### WITHDRAW_THRESHOLD
- **Source**: Environment variable or `.env` file
- **Default**: `10000000` (1 XLM)
- **Validation**: BigInt >= 0n
- **Failure**: `Invalid WITHDRAW_THRESHOLD — must be a non-negative integer`
- **Usage**: `if (accumulatedRewards >= CONFIG.withdrawThreshold) withdraw(accumulatedRewards)`
- **Example**: `10000000`

#### MAX_TASKS_PER_ROUND
- **Source**: Environment variable or `.env` file
- **Default**: `5`
- **Validation**: Integer >= 1
- **Failure**: `Invalid MAX_TASKS_PER_ROUND — must be at least 1`
- **Usage**: `const tasksToProcess = foundTasks.slice(0, CONFIG.maxTasksPerRound)`
- **Example**: `5`

#### MAX_RETRIES
- **Source**: Environment variable or `.env` file
- **Default**: `3`
- **Validation**: Integer >= 0
- **Failure**: `Invalid MAX_RETRIES — must be a non-negative integer`
- **Usage**: Passed to `withRetry(..., { maxRetries: CONFIG.maxRetries })`
- **Example**: `3`

#### RETRY_BASE_MS
- **Source**: Environment variable or `.env` file
- **Default**: `500`
- **Validation**: Integer > 0
- **Failure**: `Invalid RETRY_BASE_MS — must be greater than 0`
- **Usage**: `delay = retryBaseMs * Math.pow(2, attemptNumber) + random(0, 1000)`
- **Example**: `500`

#### EXPIRE_STALE_TASKS
- **Source**: Environment variable or `.env` file
- **Default**: `true`
- **Validation**: Parsed as boolean: `["true", "1"].includes(value.toLowerCase())`
- **Failure**: `Invalid EXPIRE_STALE_TASKS — must be "true" or "false"`
- **Usage**: `if (CONFIG.expireStaleTask && task.deadline < now) expire_task(taskId)`
- **Example**: `true`

#### MIN_PROFIT_MARGIN_STROOPS
- **Source**: Environment variable or `.env` file
- **Default**: `0`
- **Validation**: BigInt >= 0n
- **Failure**: `Invalid MIN_PROFIT_MARGIN_STROOPS — must be a non-negative integer`
- **Usage**: `if (estimatedProfit >= CONFIG.minProfitMargin) claim_task(...)`
- **Example**: `0`

#### SIMULATE_EXECUTION (Development Only)
- **Source**: Environment variable or `.env` file
- **Default**: `false`
- **Validation**: Parsed as boolean
- **Failure**: `Invalid SIMULATE_EXECUTION — must be "true" or "false"`
- **Usage**: `if (CONFIG.simulateExecution) generateSyntheticProof() else callExecutor()`
- **Warning**: Never enable in production
- **Example**: `false`

#### RUN_ONCE (Development Only)
- **Source**: Environment variable or `.env` file
- **Default**: `false`
- **Validation**: Parsed as boolean
- **Failure**: `Invalid RUN_ONCE — must be "true" or "false"`
- **Usage**: `if (CONFIG.runOnce) { await keeperLoop(); process.exit(0); } else { setInterval(keeperLoop, ...) }`
- **Use case**: Cron jobs, serverless, testing
- **Example**: `false`

## Docker Compose: Configuration Wiring

### How `.env` File Becomes Container Environment

**File: `.env`**
```
KEEPER_SECRET_KEY=SBXXXXXXX...
REGISTRY_CONTRACT_ID=CAXXXXXX...
NETWORK=testnet
DATABASE_URL=postgresql://keeper:secure_pass@postgres:5432/keeper_bot
POLL_INTERVAL_MS=10000
```

**Compose: `docker-compose.yml`**
```yaml
services:
  keeper-bot:
    env_file:
      - .env  # ← Loads all vars from .env into container environment
    environment:
      DATABASE_URL: postgresql://${DB_USER:-keeper}:${DB_PASSWORD}@postgres:5432/${DB_NAME:-keeper_bot}
      # Compose substitutes ${VAR} from shell environment or .env file
```

**Docker Process**
```bash
$ docker-compose up -d

# 1. Compose reads .env file and loads vars into shell environment
#    (export KEEPER_SECRET_KEY, REGISTRY_CONTRACT_ID, etc.)
#
# 2. Compose processes docker-compose.yml:
#    - ${DB_USER:-keeper} expands to DB_USER from .env (or "keeper" if missing)
#    - ${DB_PASSWORD} expands to DB_PASSWORD from .env
#
# 3. Docker creates container with inherited environment:
#    docker run \
#      -e KEEPER_SECRET_KEY='SBXXXXX' \
#      -e REGISTRY_CONTRACT_ID='CAXXXXX' \
#      -e NETWORK='testnet' \
#      -e DATABASE_URL='postgresql://keeper:secure_pass@postgres:5432/keeper_bot' \
#      -e POLL_INTERVAL_MS='10000' \
#      keeper-bot-v2:latest
#
# 4. Node.js process starts (CMD ["node", "index.js"])
#    - process.env contains all the above variables
#    - index.js calls validateAndLoadConfig()
#    - Configuration is validated and stored in CONFIG object
```

## Deployment Examples

### Docker Compose (Local Development)

**Setup:**
```bash
cd examples/keeper-bot-v2
cp .env.example .env
# Edit .env with real values
docker-compose up -d
```

**How it works:**
1. Compose loads `.env` file
2. Postgres service starts, initializes database
3. Keeper-bot service waits for Postgres health check
4. Keeper-bot container starts with environment variables
5. Node process validates configuration
6. Bot connects to Postgres and starts polling

**Cleanup:**
```bash
docker-compose down      # Stop containers, keep data
docker-compose down -v   # Stop containers, delete data
```

### Docker Standalone

**Build:**
```bash
docker build -t keeper-bot-v2:latest .
```

**Run against existing PostgreSQL:**
```bash
docker run \
  -e KEEPER_SECRET_KEY='SBXXXXXXX...' \
  -e REGISTRY_CONTRACT_ID='CAXXXXXX...' \
  -e NETWORK='testnet' \
  -e DATABASE_URL='postgresql://keeper:pass@my-db.example.com:5432/keeper_bot' \
  -e POLL_INTERVAL_MS='10000' \
  keeper-bot-v2:latest
```

**One-shot execution:**
```bash
docker run \
  -e RUN_ONCE='true' \
  -e KEEPER_SECRET_KEY='SBXXXXXXX...' \
  -e REGISTRY_CONTRACT_ID='CAXXXXXX...' \
  -e NETWORK='testnet' \
  -e DATABASE_URL='postgresql://keeper:pass@my-db.example.com:5432/keeper_bot' \
  keeper-bot-v2:latest
# Container exits after single round with code 0 (success) or 1 (failure)
```

### Kubernetes

**Build and push:**
```bash
docker build -t your-registry/keeper-bot-v2:latest .
docker push your-registry/keeper-bot-v2:latest
```

**Create Secret:**
```bash
kubectl create secret generic keeper-secrets \
  --from-literal=KEEPER_SECRET_KEY='SBXXXXXXX...' \
  --from-literal=DATABASE_URL='postgresql://keeper:pass@postgres:5432/keeper_bot'
```

**Deploy:**
```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: keeper-bot
spec:
  replicas: 1
  template:
    spec:
      containers:
      - name: keeper-bot
        image: your-registry/keeper-bot-v2:latest
        envFrom:
        - secretRef:
            name: keeper-secrets
        env:
        - name: REGISTRY_CONTRACT_ID
          value: CAXXXXXX...
        - name: NETWORK
          value: testnet
        - name: POLL_INTERVAL_MS
          value: "10000"
        # Graceful shutdown
        lifecycle:
          preStop:
            exec:
              command: ["/bin/sh", "-c", "sleep 5"]
        terminationGracePeriodSeconds: 30
```

### AWS ECS Fargate

**Register task definition:**
```json
{
  "family": "keeper-bot-v2",
  "networkMode": "awsvpc",
  "requiresCompatibilities": ["FARGATE"],
  "cpu": "512",
  "memory": "1024",
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
        { "name": "NETWORK", "value": "testnet" },
        { "name": "POLL_INTERVAL_MS", "value": "10000" }
      ],
      "logConfiguration": {
        "logDriver": "awslogs",
        "options": {
          "awslogs-group": "/ecs/keeper-bot",
          "awslogs-region": "us-east-1",
          "awslogs-stream-prefix": "ecs"
        }
      }
    }
  ]
}
```

**Create service:**
```bash
aws ecs create-service \
  --cluster keeper-network \
  --service-name keeper-bot \
  --task-definition keeper-bot-v2 \
  --desired-count 1 \
  --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[subnet-xxx],securityGroups=[sg-xxx],assignPublicIp=DISABLED}"
```

## Secret Hygiene Verification

### What the Container Image Contains

**Safe (no secrets):**
- Node.js runtime (20 Alpine)
- Application source code (index.js, src/)
- npm dependencies (@stellar/stellar-sdk, dotenv, etc.)
- .env.example (placeholder values only)
- docker-compose.yml (example topology)
- README.md (documentation)

**Never included (even as default values):**
- KEEPER_SECRET_KEY (example uses `SBXXXXXXX...`)
- DB_PASSWORD (example uses `CHANGE_ME_TO_A_STRONG_PASSWORD`)
- Any real credentials
- Any real contract IDs

### What Happens at Runtime

1. **Secrets supplied via environment**:
   ```bash
   docker run -e KEEPER_SECRET_KEY='actual_secret_key' keeper-bot-v2:latest
   ```

2. **Node process reads from process.env**:
   ```javascript
   const secretKey = process.env.KEEPER_SECRET_KEY;
   ```

3. **Validation with secret suppression**:
   ```javascript
   function requireEnv(name, { secret = false, ...opts }) {
     const raw = process.env[name];
     if (!validate(raw)) {
       console.error(`Invalid ${name} — ${reason}`);
       // Never logs the actual value if secret=true
       process.exit(1);
     }
     return raw;
   }
   ```

4. **Configuration stored in memory**:
   ```javascript
   const CONFIG = {
     secretKey: process.env.KEEPER_SECRET_KEY,  // Held in memory only
     registryContractId: process.env.REGISTRY_CONTRACT_ID,
     // ...
   };
   ```

5. **Logs never include secrets**:
   ```
   Soroban Keeper Network — Keeper Bot v2
   
     Network  : testnet
     Keeper   : GXXXXXXX...  (derived public key, not the secret)
     Registry : CXXXXXXX...
   ```

## Monitoring and Alerting

### Container Exits

- **0**: Successful operation or graceful shutdown
- **1**: Configuration error or runtime error
  - Check logs: `docker logs <container-id> | tail -20`
  - Error will show `Invalid <VAR_NAME> — <reason>` (secrets suppressed)

### Health Checks

**Docker Compose:**
```yaml
services:
  keeper-bot:
    healthcheck:
      test: ["CMD", "node", "-e", "process.exit(0)"]
      interval: 30s
      timeout: 5s
      retries: 3
```

**Kubernetes:**
```yaml
livenessProbe:
  exec:
    command:
    - sh
    - -c
    - ps aux | grep -q '[n]ode index.js'
  initialDelaySeconds: 10
  periodSeconds: 30
```

### Logging

**Docker:**
```bash
docker logs keeper-bot-v2
docker logs -f keeper-bot-v2  # Follow
docker logs --tail=100 keeper-bot-v2  # Last 100 lines
```

**Docker Compose:**
```bash
docker-compose logs keeper-bot
docker-compose logs -f keeper-bot
```

**Kubernetes:**
```bash
kubectl logs deployment/keeper-bot
kubectl logs -f deployment/keeper-bot
```

## References

- [Dockerfile](./Dockerfile) — Build specifications and security notes
- [docker-compose.yml](./docker-compose.yml) — Deployment topology example
- [.env.example](./.env.example) — Configuration template
- [README.md](./README.md) — Quick start and overview
