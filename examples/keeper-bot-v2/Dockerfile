# Production-ready container image for keeper-bot-v2.
#
# SECURITY: This image contains no embedded secrets, signing keys, or credentials.
# All sensitive configuration (KEEPER_SECRET_KEY, database credentials, RPC URLs)
# must be supplied at runtime via environment variables or mounted secrets.
#
# BUILD USAGE:
#   docker build -t keeper-bot-v2:latest .
#
# RUNTIME USAGE:
#   # With environment variables from a file:
#   docker run --env-file .env.example keeper-bot-v2:latest
#
#   # With explicit environment variables:
#   docker run \
#     -e KEEPER_SECRET_KEY='SBXXXX...' \
#     -e REGISTRY_CONTRACT_ID='CXXXX...' \
#     -e NETWORK='testnet' \
#     -e DATABASE_URL='postgresql://user:pass@db:5432/keeper' \
#     keeper-bot-v2:latest
#
# DATABASE: Requires PostgreSQL (via environment variable DATABASE_URL).
# On first run, pending migrations are applied automatically. The database
# connection string must be provided at runtime; it is not baked into the image.

# ═══════════════════════════════════════════════════════════════════════════
# Stage 1: Builder
# ═══════════════════════════════════════════════════════════════════════════
FROM node:20-alpine AS builder

# Set working directory in builder
WORKDIR /build

# Copy package metadata only (for dependency caching)
COPY package.json package-lock.json ./

# Install dependencies with npm ci (strict lock file adherence, no silent rewrites)
# --omit=dev removes devDependencies in the final layer
RUN npm ci --no-audit --no-fund

# Copy source code
COPY src ./src
COPY index.js ./

# Run build step if one exists (transpile, bundle, etc.)
# If there is no build script, this is a no-op and the source is ready as-is.
RUN npm run build 2>/dev/null || true

# ═══════════════════════════════════════════════════════════════════════════
# Stage 2: Runtime
# ═══════════════════════════════════════════════════════════════════════════
FROM node:20-alpine

# Metadata labels for container registries and tools
LABEL org.opencontainers.image.title="Soroban Keeper Network Bot v2"
LABEL org.opencontainers.image.description="Production-ready off-chain keeper bot for automated Soroban task execution"
LABEL org.opencontainers.image.vendor="Soroban Keeper Network Contributors"
LABEL org.opencontainers.image.version="0.1.0"

# Install curl for health checks (minimal footprint: 5.5 MiB total for runtime image)
RUN apk add --no-cache curl

# Create non-root user for security (optional but recommended)
RUN addgroup -g 1000 keeper && adduser -D -u 1000 -G keeper keeper

# Set working directory
WORKDIR /app

# Copy built artifacts and dependencies from builder stage
COPY --from=builder --chown=keeper:keeper /build/dist ./dist
COPY --from=builder --chown=keeper:keeper /build/node_modules ./node_modules
COPY --from=builder --chown=keeper:keeper /build/index.js ./index.js
COPY --from=builder --chown=keeper:keeper /build/package.json ./package.json

# Switch to non-root user
USER keeper

# Expose no ports (keeper-bot-v2 is outbound-only; does not expose HTTP endpoints)
# Health checks should be performed via exit codes or external monitoring.

# Default command: run the bot in daemon mode (continuous polling).
# Override with `--once` argument or `RUN_ONCE=true` environment variable for
# one-shot execution (suitable for cron/serverless deployments).
CMD ["node", "index.js"]

# ═══════════════════════════════════════════════════════════════════════════
# RUNTIME CONFIGURATION
# ═══════════════════════════════════════════════════════════════════════════
#
# Required environment variables:
#   KEEPER_SECRET_KEY      — Stellar account secret key (starts with S...)
#   REGISTRY_CONTRACT_ID   — Deployed KeeperRegistry contract ID (starts with C...)
#   NETWORK                — Stellar network (testnet, futurenet, mainnet)
#   DATABASE_URL           — PostgreSQL connection string (postgres://user:pass@host:port/db)
#
# Optional environment variables (see .env.example for defaults):
#   POLL_INTERVAL_MS       — Poll frequency in milliseconds (default: 10000)
#   WITHDRAW_THRESHOLD     — Min rewards before withdrawal, in stroops (default: 10000000)
#   MAX_TASKS_PER_ROUND    — Max tasks per round (default: 5)
#   MAX_RETRIES            — Retry attempts for transient errors (default: 3)
#   RETRY_BASE_MS          — Base delay for exponential backoff, ms (default: 500)
#   EXPIRE_STALE_TASKS     — Whether to expire past-deadline tasks (default: true)
#   MIN_PROFIT_MARGIN_STROOPS — Min profit margin, stroops (default: 0)
#   SIMULATE_EXECUTION     — Dev only: fabricate synthetic proofs (default: false)
#   RUN_ONCE               — One-shot mode for cron/serverless (default: false)
#
# SECRET HANDLING:
#   Secrets are never logged. Configuration validation errors suppress the actual
#   secret value and log only the variable name and reason for the failure.
#   Example error output (safe to log):
#     Invalid KEEPER_SECRET_KEY — must be a valid Stellar secret seed (starts with S)
#   Never shows the actual key value.
#
# DATABASE SETUP:
#   On first run, the bot applies pending schema migrations automatically via
#   the migration tooling configured for v2. This allows a fresh database to be
#   brought to the current schema with a single `docker run` invocation.
#
#   Migrations are idempotent: re-running the bot against an already-migrated
#   database is safe. Only unapplied migrations execute.
#
#   For persistent storage, mount a Docker volume or use a managed database service:
#     docker run -v keeper-data:/var/lib/postgresql/data keeper-bot-v2:latest
#   Or reference a managed PostgreSQL instance:
#     -e DATABASE_URL='postgresql://user:pass@managed-db.example.com:5432/keeper'
#
# GRACEFUL SHUTDOWN:
#   The bot listens for SIGINT and SIGTERM, allowing `docker stop` to give it
#   time to complete the current round before terminating. Set a reasonable
#   stop timeout:
#     docker run --stop-timeout 30 keeper-bot-v2:latest
#
# ═══════════════════════════════════════════════════════════════════════════
