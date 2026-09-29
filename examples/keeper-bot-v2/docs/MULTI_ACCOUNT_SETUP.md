# Multi-Account Setup for keeper-bot-v2

## Overview

A single Stellar account has one sequence number, which serializes submitted transactions from that account regardless of how much concurrency the bot adds at the application level. To achieve genuine submission parallelism and avoid bottlenecking on a single account's sequence number, keeper-bot-v2 supports running against a pool of signing accounts.

This document explains:

- How to configure and fund multiple accounts
- How reward accounting works across a pool
- How to withdraw rewards from each account
- Pool selection strategies
- Operational recommendations

## Quick Start: Single vs. Multiple Accounts

### Single Account (Backward Compatible)

```bash
export KEEPER_SECRET_KEY=S...
```

This is the traditional setup. The bot uses one account for all transactions.

### Multiple Accounts (New Pool Mode)

Choose one of these configuration methods:

#### Option A: Comma-Separated List

```bash
export KEEPER_SECRET_KEYS="S...,S...,S..."
export KEEPER_POOL_STRATEGY=round-robin  # or least-loaded, default: round-robin
```

#### Option B: Indexed Environment Variables

```bash
export KEEPER_SECRET_KEY_0=S...
export KEEPER_SECRET_KEY_1=S...
export KEEPER_SECRET_KEY_2=S...
export KEEPER_POOL_STRATEGY=round-robin  # optional
```

#### Option C: Single Variable (Backward Compatible)

```bash
export KEEPER_SECRET_KEY=S...  # still works, uses only one account
```

## Account Funding

**Each account in the pool must be independently funded on Stellar.**

When you configure a pool of N accounts, you must:

1. Create N separate Stellar keypairs
2. Fund each keypair's public address with enough XLM for:
   - Transaction fees (typically 100 stroops per operation)
   - Any locks or deposits required by the contract
3. Distribute the secret keys to the bot's environment (as shown above)

### Example: 3-Account Pool Setup

```bash
# Generate 3 keypairs (use stellar-cli, js-stellar-sdk, or similar)
# Keypair 1: SABC123... (public: GABC123...)
# Keypair 2: SDEF456... (public: GDEF456...)
# Keypair 3: SGHI789... (public: GGHI789...)

# Fund each public key with XLM on your network
# (testnet: use friendbot; mainnet: send XLM)

# Configure the bot
export KEEPER_SECRET_KEYS="SABC123...,SDEF456...,SGHI789..."
```

## Reward Accounting per Account

**Critical:** On-chain, `keeper_balance` is tracked per address. When you run a pool of N accounts, your keeper's total earnings are split across N addresses.

### Example

If your keeper network distributed 100 XLM total in rewards:

- Single account: Account A accumulates 100 XLM reward balance
- Three-account pool: Rewards split ~33.3 XLM per account (depending on task distribution)

Each address' balance is independent:

```bash
# Check balance for account 1
keeper-balance GABC123...  # might show 33.3 XLM

# Check balance for account 2
keeper-balance GDEF456...  # might show 33.2 XLM

# Check balance for account 3
keeper-balance GGHI789...  # might show 33.5 XLM
```

The total rewards = sum of all per-address balances.

## Withdrawal Strategy

**You must withdraw rewards separately from each account.**

The contract's `withdraw_rewards(keeper)` function is per-address. There is no single "withdraw all from all accounts" operation.

### Single Account Withdrawal

```bash
# One withdrawal call, one address
keeper-withdraw --keeper GABC123...
```

### Pool Withdrawal (N Accounts)

```bash
# Must run N separate withdrawal calls
keeper-withdraw --keeper GABC123...
keeper-withdraw --keeper GDEF456...
keeper-withdraw --keeper GGHI789...
```

Recommendation: Automate this with a script or cron job that iterates over all your pool addresses.

### Withdrawal Accounting

Keep track of when you withdrew from each account to reconcile your earnings:

| Account | Address    | Balance (before) | Withdrawn | Balance (after) |
| ------- | ---------- | ---------------- | --------- | --------------- |
| 1       | GABC123... | 50.5 XLM         | 50.0 XLM  | 0.5 XLM         |
| 2       | GDEF456... | 49.8 XLM         | 49.8 XLM  | 0.0 XLM         |
| 3       | GGHI789...| 51.2 XLM         | 51.0 XLM  | 0.2 XLM         |
| **Total** | — | **151.5 XLM** | **150.8 XLM** | **0.7 XLM** |

## Pool Strategies

### Round-Robin (Default)

Acquires accounts in cyclic order: account-0, account-1, account-2, account-0, ...

**Use when:**
- Your accounts have similar liquidity and fee capacity
- You want predictable, even distribution

**Configuration:**

```bash
export KEEPER_POOL_STRATEGY=round-robin
```

### Least-Loaded

Acquires the account with the fewest in-flight transactions at that moment.

**Use when:**
- Your accounts have different performance or capacity
- You want to dynamically load-balance during traffic spikes
- You want to maximize concurrency by avoiding bottlenecks on any single account

**Configuration:**

```bash
export KEEPER_POOL_STRATEGY=least-loaded
```

## Size Recommendations

### Matching Concurrency Level

From issue 0253 (concurrent task processing), the bot processes multiple tasks in parallel within each round, bounded by a concurrency limit (e.g., 10 concurrent tasks).

**Recommendation:** Your pool size should match or exceed your concurrency limit.

- **Concurrency = 10 tasks/round:** Use a pool of at least 10 accounts
- **Concurrency = 5 tasks/round:** Use a pool of at least 5 accounts
- **Single-task rounds:** Use 1 account (or keep your existing setup)

This ensures that each concurrent task can acquire its own account and avoid sequence-number bottlenecks.

### Network Fee Capacity

Each account must have enough XLM to cover transaction fees during heavy periods.

- **10 concurrent submissions/round × 100 stroops per tx = 1,000 stroops (0.0001 XLM) per round**
- **If rounds occur every 5 seconds: 0.0001 XLM × 12 rounds/min × 60 min/hr = 0.072 XLM/hour**

Fund each account with enough to sustain peak transaction load for at least a few hours of operation.

## Migration: Single → Multiple Accounts

If you're running a single account and want to scale to a pool:

1. **Generate new keypairs** for additional accounts
2. **Fund all new accounts** with sufficient XLM
3. **Update environment variables** (choose one config method above)
4. **Restart the bot**
5. **Verify connectivity** by checking logs for all accounts appearing in balance checks or metrics

Your existing single account's earnings remain on that address. New tasks will be distributed across the pool going forward.

## Monitoring and Observability

The bot should expose per-account metrics in its status endpoint or logs:

```
Account stats:
  - account-0 (GABC123...): 1,250 tasks executed, 3 pending
  - account-1 (GDEF456...): 1,245 tasks executed, 2 pending
  - account-2 (GGHI789...): 1,268 tasks executed, 5 pending
```

Use these metrics to:

- **Detect imbalance:** If one account has far more pending tasks, it may be lagging (network, performance)
- **Plan funding:** If pending counts are high, ensure sufficient XLM across all accounts
- **Validate distribution:** Confirm the strategy (round-robin vs. least-loaded) is behaving as expected

## Troubleshooting

### Account Not Being Used

**Symptom:** One account in your pool has 0 pending/executed tasks.

**Cause:**
- Invalid secret key (parsing error caught at startup)
- Duplicate secret keys in the configuration
- Duplicate public key from two different secret keys (shouldn't happen with correct keypair generation)

**Fix:** Check the bot's startup logs for errors, validate your environment variables.

### Uneven Task Distribution

**Symptom:** With round-robin, tasks are not distributed evenly.

**Cause:** This is expected if the bot restarts mid-round or if acquisition is not always called. The round-robin index does not persist across restarts.

**Fix:** If distribution must be perfectly even, use least-loaded strategy or investigate why acquisition calls are missing.

### Sequence Number Errors After Scaling

**Symptom:** After adding more accounts, you still see "sequence number mismatch" errors.

**Cause:**
- New account not properly funded (bot falling back to old account)
- Old account not fully drained before scaling
- Concurrency limit still set too low relative to pool size

**Fix:**
- Verify all accounts are funded
- Check that bot logs confirm using all accounts
- Increase concurrency limit if needed

## Security Considerations

1. **Secret keys in environment variables:** Use secure secret management (e.g., AWS Secrets Manager, HashiCorp Vault, systemd secrets)
2. **Per-account auditing:** Monitor on-chain to confirm expected transactions from each account
3. **Key rotation:** If you suspect a key is compromised, rotate it by updating the environment and restarting the bot
4. **Funding limits:** Consider funding each account with only the minimum needed for a few rounds, and refill programmatically or on a schedule

## Example: Complete 3-Account Setup

```bash
#!/bin/bash

# Generate keypairs (one-time setup)
KEY_1=$(stellar-cli keygen)   # outputs secret
KEY_2=$(stellar-cli keygen)
KEY_3=$(stellar-cli keygen)

# Fund each on testnet (example using friendbot)
PUB_1=$(echo $KEY_1 | stellar-cli account-from-secret)
curl "https://friendbot.stellar.org?addr=$PUB_1"
# repeat for $PUB_2, $PUB_3

# Configure bot environment
export KEEPER_SECRET_KEYS="$KEY_1,$KEY_2,$KEY_3"
export KEEPER_POOL_STRATEGY=least-loaded
export KEEPER_CONCURRENCY=10  # match pool size

# Start bot
npm run start

# Later: check balances
keeper-registry balance $PUB_1
keeper-registry balance $PUB_2
keeper-registry balance $PUB_3

# Withdraw rewards from all
keeper-registry withdraw --keeper $PUB_1
keeper-registry withdraw --keeper $PUB_2
keeper-registry withdraw --keeper $PUB_3
```

## Related Issues

- **Issue 0253:** Concurrent task processing — explains how concurrency limits work and why pool size matters
- **Issue 0252:** Persistent state schema — how the bot avoids double-claiming across restarts
- **Issue 0260:** Fee market adaptation — how the bot chooses fees per transaction (applies per account)
