import { Keypair } from "@stellar/stellar-sdk";

// ── Types ──────────────────────────────────────────────────────────────

export interface SigningAccount {
  publicKey: string;
  keypair: Keypair; // used for signing transactions
  label: string; // human-readable label for logs/tracking
}

export interface AccountPoolConfig {
  accounts: SigningAccountConfig[];
  strategy?: "round-robin" | "least-loaded"; // default: round-robin
}

export interface SigningAccountConfig {
  secretKey: string;
  label?: string;
}

export interface AccountUsageStats {
  publicKey: string;
  label: string;
  tasksExecuted: number;
  tasksAttempted: number;
  lastUsedAt: Date | null;
  pendingCount: number; // currently in-flight transactions
}

// ── AccountPool ────────────────────────────────────────────────────────

export class AccountPool {
  private accounts: SigningAccount[];
  private strategy: "round-robin" | "least-loaded";
  private roundRobinIndex: number = 0;
  private pendingCounts: Map<string, number> = new Map();
  private taskExecutionCounts: Map<string, number> = new Map();
  private lastUsed: Map<string, Date> = new Map();

  constructor(config: AccountPoolConfig) {
    if (!config.accounts || config.accounts.length === 0) {
      throw new Error("AccountPool requires at least one signing account");
    }

    this.strategy = config.strategy ?? "round-robin";

    this.accounts = config.accounts.map((cfg, index) => {
      let keypair: Keypair;

      try {
        keypair = Keypair.fromSecret(cfg.secretKey);
      } catch {
        throw new Error(
          `Invalid secret key for account at index ${index}${
            cfg.label ? ` (${cfg.label})` : ""
          }`
        );
      }

      const publicKey = keypair.publicKey();

      this.pendingCounts.set(publicKey, 0);
      this.taskExecutionCounts.set(publicKey, 0);

      return {
        publicKey,
        keypair,
        label: cfg.label ?? `account-${index}`,
      };
    });

    // Detect duplicate accounts
    const publicKeys = this.accounts.map((a) => a.publicKey);
    const unique = new Set(publicKeys);

    if (unique.size !== publicKeys.length) {
      throw new Error("AccountPool contains duplicate signing accounts");
    }
  }

  /**
   * Acquire the next available account from the pool.
   * Concurrent claims are distributed across the pool
   * so they do NOT serialize on one account's sequence number.
   */
  acquire(): SigningAccount {
    if (this.strategy === "least-loaded") {
      return this.acquireLeastLoaded();
    }

    return this.acquireRoundRobin();
  }

  private acquireRoundRobin(): SigningAccount {
    const account = this.accounts[this.roundRobinIndex];

    this.roundRobinIndex =
      (this.roundRobinIndex + 1) % this.accounts.length;

    this.pendingCounts.set(
      account.publicKey,
      (this.pendingCounts.get(account.publicKey) ?? 0) + 1
    );

    return account;
  }

  private acquireLeastLoaded(): SigningAccount {
    // Pick account with fewest in-flight transactions
    let leastLoaded = this.accounts[0];
    let minPending = this.pendingCounts.get(leastLoaded.publicKey) ?? 0;

    for (const account of this.accounts) {
      const pending = this.pendingCounts.get(account.publicKey) ?? 0;

      if (pending < minPending) {
        minPending = pending;
        leastLoaded = account;
      }
    }

    this.pendingCounts.set(
      leastLoaded.publicKey,
      (this.pendingCounts.get(leastLoaded.publicKey) ?? 0) + 1
    );

    return leastLoaded;
  }

  /**
   * Release an account after transaction completes or fails.
   * Must be called in a finally block to prevent leak.
   */
  release(publicKey: string, success: boolean): void {
    const current = this.pendingCounts.get(publicKey) ?? 0;

    this.pendingCounts.set(publicKey, Math.max(0, current - 1));

    this.lastUsed.set(publicKey, new Date());

    if (success) {
      this.taskExecutionCounts.set(
        publicKey,
        (this.taskExecutionCounts.get(publicKey) ?? 0) + 1
      );
    }
  }

  /**
   * Get per-account stats for reward accounting.
   * keeper_balance is per-address on-chain — each account tracks its own earnings.
   */
  getStats(): AccountUsageStats[] {
    return this.accounts.map((account) => ({
      publicKey: account.publicKey,
      label: account.label,
      tasksExecuted: this.taskExecutionCounts.get(account.publicKey) ?? 0,
      tasksAttempted: 0, // tracked externally
      lastUsedAt: this.lastUsed.get(account.publicKey) ?? null,
      pendingCount: this.pendingCounts.get(account.publicKey) ?? 0,
    }));
  }

  getAccount(publicKey: string): SigningAccount | undefined {
    return this.accounts.find((a) => a.publicKey === publicKey);
  }

  size(): number {
    return this.accounts.length;
  }

  publicKeys(): string[] {
    return this.accounts.map((a) => a.publicKey);
  }
}

// ── Configuration parsing ──────────────────────────────────────────────

/**
 * Parse account pool from environment variables.
 *
 * Single account (backward compatible):
 *   KEEPER_SECRET_KEY=S...
 *
 * Multiple accounts (new pool mode):
 *   KEEPER_SECRET_KEYS=S...,S...,S...
 *   or
 *   KEEPER_SECRET_KEY_0=S...
 *   KEEPER_SECRET_KEY_1=S...
 *   KEEPER_SECRET_KEY_2=S...
 */
export function parseAccountPoolFromEnv(): AccountPoolConfig {
  // Multi-account: comma-separated list
  if (process.env.KEEPER_SECRET_KEYS) {
    const keys = process.env.KEEPER_SECRET_KEYS.split(",")
      .map((k) => k.trim())
      .filter(Boolean);

    return {
      accounts: keys.map((secretKey, i) => ({
        secretKey,
        label: `account-${i}`,
      })),
      strategy:
        (process.env
          .KEEPER_POOL_STRATEGY as "round-robin" | "least-loaded") ??
        "round-robin",
    };
  }

  // Multi-account: indexed env vars
  const indexedKeys: string[] = [];

  for (let i = 0; ; i++) {
    const key = process.env[`KEEPER_SECRET_KEY_${i}`];

    if (!key) break;

    indexedKeys.push(key);
  }

  if (indexedKeys.length > 0) {
    return {
      accounts: indexedKeys.map((secretKey, i) => ({
        secretKey,
        label: `account-${i}`,
      })),
      strategy:
        (process.env
          .KEEPER_POOL_STRATEGY as "round-robin" | "least-loaded") ??
        "round-robin",
    };
  }

  // Single account: backward compatible
  const singleKey = process.env.KEEPER_SECRET_KEY;

  if (!singleKey) {
    throw new Error(
      "No signing accounts configured. Set KEEPER_SECRET_KEY (single) or " +
        "KEEPER_SECRET_KEYS (comma-separated) or KEEPER_SECRET_KEY_0, KEEPER_SECRET_KEY_1, ..."
    );
  }

  return {
    accounts: [{ secretKey: singleKey, label: "account-0" }],
    strategy: "round-robin",
  };
}
