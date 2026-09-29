import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import {
  AccountPool,
  AccountPoolConfig,
  SigningAccountConfig,
  parseAccountPoolFromEnv,
} from "./accounts";

// ── Test Helpers ───────────────────────────────────────────────────────

/**
 * Create a valid secret key for testing purposes.
 * Each unique seed produces a consistent, valid keypair.
 */
function createTestSecretKey(seed: number): string {
  const buffer = Buffer.alloc(32);
  buffer.writeUInt32LE(seed, 0);
  return Keypair.fromRawEd25519Seed(buffer).secret();
}

function saveEnv() {
  return { ...process.env };
}

function restoreEnv(saved: NodeJS.ProcessEnv) {
  // Clear all KEEPER_* env vars
  Object.keys(process.env).forEach((key) => {
    if (key.startsWith("KEEPER_")) {
      delete process.env[key];
    }
  });

  // Restore saved ones
  Object.entries(saved).forEach(([key, value]) => {
    if (key.startsWith("KEEPER_")) {
      process.env[key] = value;
    }
  });
}

// ── Constructor Tests ──────────────────────────────────────────────────

describe("AccountPool constructor", () => {
  it("creates pool with single account correctly", () => {
    const secretKey = createTestSecretKey(1);
    const config: AccountPoolConfig = {
      accounts: [{ secretKey, label: "primary" }],
    };

    const pool = new AccountPool(config);

    expect(pool.size()).toBe(1);
    const stats = pool.getStats();
    expect(stats[0].label).toBe("primary");
    expect(stats[0].tasksExecuted).toBe(0);
    expect(stats[0].pendingCount).toBe(0);
  });

  it("creates pool with multiple accounts", () => {
    const config: AccountPoolConfig = {
      accounts: [
        { secretKey: createTestSecretKey(1), label: "account-1" },
        { secretKey: createTestSecretKey(2), label: "account-2" },
        { secretKey: createTestSecretKey(3), label: "account-3" },
      ],
    };

    const pool = new AccountPool(config);

    expect(pool.size()).toBe(3);
    const stats = pool.getStats();
    expect(stats.map((s) => s.label)).toEqual(["account-1", "account-2", "account-3"]);
  });

  it("throws when accounts array is empty", () => {
    const config: AccountPoolConfig = { accounts: [] };

    expect(() => new AccountPool(config)).toThrow(
      "AccountPool requires at least one signing account"
    );
  });

  it("throws when account is undefined", () => {
    const config = {
      accounts: undefined as unknown as SigningAccountConfig[],
    };

    expect(() => new AccountPool(config)).toThrow(
      "AccountPool requires at least one signing account"
    );
  });

  it("throws on invalid secret key with index in error message", () => {
    const config: AccountPoolConfig = {
      accounts: [
        { secretKey: createTestSecretKey(1) },
        { secretKey: "invalid-secret-key", label: "bad-account" },
      ],
    };

    expect(() => new AccountPool(config)).toThrow(
      /Invalid secret key for account at index 1 \(bad-account\)/
    );
  });

  it("throws on invalid secret key without label", () => {
    const config: AccountPoolConfig = {
      accounts: [{ secretKey: "invalid-secret-key" }],
    };

    expect(() => new AccountPool(config)).toThrow(
      /Invalid secret key for account at index 0$/
    );
  });

  it("auto-assigns labels when not provided", () => {
    const config: AccountPoolConfig = {
      accounts: [
        { secretKey: createTestSecretKey(1) },
        { secretKey: createTestSecretKey(2) },
        { secretKey: createTestSecretKey(3) },
      ],
    };

    const pool = new AccountPool(config);

    const stats = pool.getStats();
    expect(stats[0].label).toBe("account-0");
    expect(stats[1].label).toBe("account-1");
    expect(stats[2].label).toBe("account-2");
  });

  it("preserves custom labels", () => {
    const config: AccountPoolConfig = {
      accounts: [
        { secretKey: createTestSecretKey(1), label: "primary" },
        { secretKey: createTestSecretKey(2), label: "backup" },
      ],
    };

    const pool = new AccountPool(config);

    const stats = pool.getStats();
    expect(stats[0].label).toBe("primary");
    expect(stats[1].label).toBe("backup");
  });

  it("throws on duplicate secret keys", () => {
    const duplicateKey = createTestSecretKey(1);
    const config: AccountPoolConfig = {
      accounts: [
        { secretKey: duplicateKey, label: "account-a" },
        { secretKey: duplicateKey, label: "account-b" },
      ],
    };

    expect(() => new AccountPool(config)).toThrow(
      "AccountPool contains duplicate signing accounts"
    );
  });

  it("stores correct public keys for each account", () => {
    const key1 = createTestSecretKey(1);
    const key2 = createTestSecretKey(2);

    const keypair1 = Keypair.fromSecret(key1);
    const keypair2 = Keypair.fromSecret(key2);

    const config: AccountPoolConfig = {
      accounts: [
        { secretKey: key1 },
        { secretKey: key2 },
      ],
    };

    const pool = new AccountPool(config);

    const stats = pool.getStats();
    expect(stats[0].publicKey).toBe(keypair1.publicKey());
    expect(stats[1].publicKey).toBe(keypair2.publicKey());
  });
});

// ── Round-Robin Acquisition Tests ──────────────────────────────────────

describe("AccountPool.acquire() with round-robin strategy", () => {
  it("returns first account on first acquire", () => {
    const config: AccountPoolConfig = {
      accounts: [
        { secretKey: createTestSecretKey(1), label: "account-0" },
        { secretKey: createTestSecretKey(2), label: "account-1" },
      ],
      strategy: "round-robin",
    };

    const pool = new AccountPool(config);
    const account = pool.acquire();

    expect(account.label).toBe("account-0");
  });

  it("returns second account on second acquire", () => {
    const config: AccountPoolConfig = {
      accounts: [
        { secretKey: createTestSecretKey(1), label: "account-0" },
        { secretKey: createTestSecretKey(2), label: "account-1" },
      ],
      strategy: "round-robin",
    };

    const pool = new AccountPool(config);
    pool.acquire();
    const second = pool.acquire();

    expect(second.label).toBe("account-1");
  });

  it("wraps around after reaching end of pool", () => {
    const config: AccountPoolConfig = {
      accounts: [
        { secretKey: createTestSecretKey(1), label: "account-0" },
        { secretKey: createTestSecretKey(2), label: "account-1" },
        { secretKey: createTestSecretKey(3), label: "account-2" },
      ],
      strategy: "round-robin",
    };

    const pool = new AccountPool(config);
    const first = pool.acquire();
    const second = pool.acquire();
    const third = pool.acquire();
    const fourth = pool.acquire(); // should wrap

    expect(first.label).toBe("account-0");
    expect(second.label).toBe("account-1");
    expect(third.label).toBe("account-2");
    expect(fourth.label).toBe("account-0");
  });

  it("increments pending count on acquire", () => {
    const config: AccountPoolConfig = {
      accounts: [{ secretKey: createTestSecretKey(1) }],
      strategy: "round-robin",
    };

    const pool = new AccountPool(config);
    const before = pool.getStats()[0].pendingCount;
    pool.acquire();
    const after = pool.getStats()[0].pendingCount;

    expect(before).toBe(0);
    expect(after).toBe(1);
  });

  it("round-robin works correctly with single account", () => {
    const config: AccountPoolConfig = {
      accounts: [{ secretKey: createTestSecretKey(1) }],
      strategy: "round-robin",
    };

    const pool = new AccountPool(config);
    const first = pool.acquire();
    const second = pool.acquire();
    const third = pool.acquire();

    expect(first.label).toBe(second.label);
    expect(second.label).toBe(third.label);
  });
});

// ── Least-Loaded Acquisition Tests ─────────────────────────────────────

describe("AccountPool.acquire() with least-loaded strategy", () => {
  it("returns account with fewest pending transactions", () => {
    const config: AccountPoolConfig = {
      accounts: [
        { secretKey: createTestSecretKey(1), label: "account-0" },
        { secretKey: createTestSecretKey(2), label: "account-1" },
        { secretKey: createTestSecretKey(3), label: "account-2" },
      ],
      strategy: "least-loaded",
    };

    const pool = new AccountPool(config);

    // Manually load up account-0 and account-1
    const acct0 = pool.acquire();
    pool.acquire();
    pool.acquire();

    // Next acquire should pick account-2 (least loaded)
    const next = pool.acquire();

    expect(next.label).toBe("account-2");
  });

  it("returns first tied account when multiple have same pending count", () => {
    const config: AccountPoolConfig = {
      accounts: [
        { secretKey: createTestSecretKey(1), label: "account-0" },
        { secretKey: createTestSecretKey(2), label: "account-1" },
      ],
      strategy: "least-loaded",
    };

    const pool = new AccountPool(config);

    // Both have 0 pending initially
    const first = pool.acquire();
    expect(first.label).toBe("account-0"); // first in pool, first when tied
  });

  it("tracks pending counts correctly across multiple acquires", () => {
    const config: AccountPoolConfig = {
      accounts: [
        { secretKey: createTestSecretKey(1), label: "account-0" },
        { secretKey: createTestSecretKey(2), label: "account-1" },
      ],
      strategy: "least-loaded",
    };

    const pool = new AccountPool(config);

    const acct0 = pool.acquire();
    const acct0_2 = pool.acquire();
    expect(acct0.label).toBe("account-0");
    expect(acct0_2.label).toBe("account-0"); // both are least-loaded initially

    const acct1 = pool.acquire(); // now picks account-1
    expect(acct1.label).toBe("account-1");

    // account-1 should now be least-loaded (only 1 vs 2)
    const acct1_2 = pool.acquire();
    expect(acct1_2.label).toBe("account-1");
  });
});

// ── Release Tests ──────────────────────────────────────────────────────

describe("AccountPool.release()", () => {
  it("decrements pending count on release", () => {
    const config: AccountPoolConfig = {
      accounts: [{ secretKey: createTestSecretKey(1) }],
    };

    const pool = new AccountPool(config);
    const account = pool.acquire();

    expect(pool.getStats()[0].pendingCount).toBe(1);

    pool.release(account.publicKey, false);

    expect(pool.getStats()[0].pendingCount).toBe(0);
  });

  it("increments tasksExecuted on successful release", () => {
    const config: AccountPoolConfig = {
      accounts: [{ secretKey: createTestSecretKey(1) }],
    };

    const pool = new AccountPool(config);
    const account = pool.acquire();

    expect(pool.getStats()[0].tasksExecuted).toBe(0);

    pool.release(account.publicKey, true);

    expect(pool.getStats()[0].tasksExecuted).toBe(1);
  });

  it("does NOT increment tasksExecuted on failed release", () => {
    const config: AccountPoolConfig = {
      accounts: [{ secretKey: createTestSecretKey(1) }],
    };

    const pool = new AccountPool(config);
    const account = pool.acquire();

    pool.release(account.publicKey, false);

    expect(pool.getStats()[0].tasksExecuted).toBe(0);
  });

  it("prevents pending count from going below zero", () => {
    const config: AccountPoolConfig = {
      accounts: [{ secretKey: createTestSecretKey(1) }],
    };

    const pool = new AccountPool(config);
    const account = pool.acquire();

    pool.release(account.publicKey, false);
    pool.release(account.publicKey, false); // second release on zero

    expect(pool.getStats()[0].pendingCount).toBe(0);
  });

  it("updates lastUsedAt on release", () => {
    const config: AccountPoolConfig = {
      accounts: [{ secretKey: createTestSecretKey(1) }],
    };

    const pool = new AccountPool(config);
    const account = pool.acquire();

    const statsBefore = pool.getStats()[0];
    expect(statsBefore.lastUsedAt).toBeNull();

    const beforeRelease = new Date();
    pool.release(account.publicKey, false);
    const afterRelease = new Date();

    const statsAfter = pool.getStats()[0];
    expect(statsAfter.lastUsedAt).not.toBeNull();
    expect(statsAfter.lastUsedAt!.getTime()).toBeGreaterThanOrEqual(
      beforeRelease.getTime()
    );
    expect(statsAfter.lastUsedAt!.getTime()).toBeLessThanOrEqual(
      afterRelease.getTime()
    );
  });

  it("correctly tracks multiple successes and failures per account", () => {
    const config: AccountPoolConfig = {
      accounts: [{ secretKey: createTestSecretKey(1) }],
    };

    const pool = new AccountPool(config);
    const account = pool.acquire();

    pool.release(account.publicKey, true); // success
    pool.acquire();
    pool.release(account.publicKey, false); // failure
    pool.acquire();
    pool.release(account.publicKey, true); // success

    expect(pool.getStats()[0].tasksExecuted).toBe(2);
  });
});

// ── Concurrent Distribution Tests ─────────────────────────────────────

describe("AccountPool concurrent distribution", () => {
  it("distributes N concurrent tasks across N accounts in pool", () => {
    const config: AccountPoolConfig = {
      accounts: [
        { secretKey: createTestSecretKey(1), label: "account-0" },
        { secretKey: createTestSecretKey(2), label: "account-1" },
        { secretKey: createTestSecretKey(3), label: "account-2" },
      ],
      strategy: "round-robin",
    };

    const pool = new AccountPool(config);

    // Acquire 3 accounts for 3 concurrent tasks
    const task1Account = pool.acquire();
    const task2Account = pool.acquire();
    const task3Account = pool.acquire();

    // Each should be different when pool is large enough
    const labels = new Set([
      task1Account.label,
      task2Account.label,
      task3Account.label,
    ]);
    expect(labels.size).toBe(3);
  });

  it("shares accounts when concurrency exceeds pool size", () => {
    const config: AccountPoolConfig = {
      accounts: [
        { secretKey: createTestSecretKey(1), label: "account-0" },
        { secretKey: createTestSecretKey(2), label: "account-1" },
      ],
      strategy: "round-robin",
    };

    const pool = new AccountPool(config);

    const task1 = pool.acquire();
    const task2 = pool.acquire();
    const task3 = pool.acquire(); // more than pool size
    const task4 = pool.acquire();

    // task1 and task3 should use same account
    expect(task1.label).toBe(task3.label);
    // task2 and task4 should use same account
    expect(task2.label).toBe(task4.label);
  });

  it("load balances with least-loaded when concurrency exceeds pool size", () => {
    const config: AccountPoolConfig = {
      accounts: [
        { secretKey: createTestSecretKey(1), label: "account-0" },
        { secretKey: createTestSecretKey(2), label: "account-1" },
      ],
      strategy: "least-loaded",
    };

    const pool = new AccountPool(config);

    // Acquire many tasks: least-loaded should distribute evenly
    const acquired = [];
    for (let i = 0; i < 10; i++) {
      acquired.push(pool.acquire());
    }

    const stats = pool.getStats();
    const pendingCounts = stats.map((s) => s.pendingCount);

    // With 2 accounts and 10 acquired, each should have around 5
    // Least-loaded should try to keep them balanced
    expect(pendingCounts[0]).toBe(5);
    expect(pendingCounts[1]).toBe(5);
  });
});

// ── Reward Accounting Tests ────────────────────────────────────────────

describe("AccountPool reward accounting", () => {
  it("getStats returns entry per account", () => {
    const config: AccountPoolConfig = {
      accounts: [
        { secretKey: createTestSecretKey(1) },
        { secretKey: createTestSecretKey(2) },
        { secretKey: createTestSecretKey(3) },
      ],
    };

    const pool = new AccountPool(config);
    const stats = pool.getStats();

    expect(stats).toHaveLength(3);
  });

  it("tracks tasksExecuted per-address independently", () => {
    const config: AccountPoolConfig = {
      accounts: [
        { secretKey: createTestSecretKey(1), label: "account-0" },
        { secretKey: createTestSecretKey(2), label: "account-1" },
      ],
    };

    const pool = new AccountPool(config);

    const acct0 = pool.acquire();
    pool.release(acct0.publicKey, true);
    pool.release(acct0.publicKey, true);
    pool.release(acct0.publicKey, true);

    const acct1 = pool.acquire();
    pool.release(acct1.publicKey, true);

    const stats = pool.getStats();
    const acct0Stats = stats.find((s) => s.label === "account-0");
    const acct1Stats = stats.find((s) => s.label === "account-1");

    expect(acct0Stats!.tasksExecuted).toBe(3);
    expect(acct1Stats!.tasksExecuted).toBe(1);
  });

  it("each account's stats are independent", () => {
    const config: AccountPoolConfig = {
      accounts: [
        { secretKey: createTestSecretKey(1), label: "account-0" },
        { secretKey: createTestSecretKey(2), label: "account-1" },
      ],
    };

    const pool = new AccountPool(config);

    const acct0 = pool.acquire();
    pool.acquire();
    const acct1 = pool.acquire();

    pool.release(acct0.publicKey, true);
    pool.release(acct1.publicKey, false);

    const stats = pool.getStats();
    expect(stats[0].tasksExecuted).toBe(1);
    expect(stats[1].tasksExecuted).toBe(0);
  });

  it("publicKey and label are correct in stats", () => {
    const key0 = createTestSecretKey(1);
    const key1 = createTestSecretKey(2);

    const keypair0 = Keypair.fromSecret(key0);
    const keypair1 = Keypair.fromSecret(key1);

    const config: AccountPoolConfig = {
      accounts: [
        { secretKey: key0, label: "keeper-1" },
        { secretKey: key1, label: "keeper-2" },
      ],
    };

    const pool = new AccountPool(config);
    const stats = pool.getStats();

    expect(stats[0].publicKey).toBe(keypair0.publicKey());
    expect(stats[0].label).toBe("keeper-1");

    expect(stats[1].publicKey).toBe(keypair1.publicKey());
    expect(stats[1].label).toBe("keeper-2");
  });
});

// ── Environment Parsing Tests ──────────────────────────────────────────

describe("parseAccountPoolFromEnv", () => {
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    savedEnv = saveEnv();
  });

  afterEach(() => {
    restoreEnv(savedEnv);
  });

  it("parses KEEPER_SECRET_KEY for single account backward compatibility", () => {
    const secretKey = createTestSecretKey(1);
    process.env.KEEPER_SECRET_KEY = secretKey;

    const config = parseAccountPoolFromEnv();

    expect(config.accounts).toHaveLength(1);
    expect(config.accounts[0].secretKey).toBe(secretKey);
    expect(config.accounts[0].label).toBe("account-0");
    expect(config.strategy).toBe("round-robin");
  });

  it("parses KEEPER_SECRET_KEYS comma-separated list", () => {
    const key1 = createTestSecretKey(1);
    const key2 = createTestSecretKey(2);
    const key3 = createTestSecretKey(3);

    process.env.KEEPER_SECRET_KEYS = `${key1},${key2},${key3}`;

    const config = parseAccountPoolFromEnv();

    expect(config.accounts).toHaveLength(3);
    expect(config.accounts[0].secretKey).toBe(key1);
    expect(config.accounts[1].secretKey).toBe(key2);
    expect(config.accounts[2].secretKey).toBe(key3);
  });

  it("handles whitespace in comma-separated keys", () => {
    const key1 = createTestSecretKey(1);
    const key2 = createTestSecretKey(2);

    process.env.KEEPER_SECRET_KEYS = `  ${key1}  ,  ${key2}  `;

    const config = parseAccountPoolFromEnv();

    expect(config.accounts).toHaveLength(2);
    expect(config.accounts[0].secretKey).toBe(key1);
    expect(config.accounts[1].secretKey).toBe(key2);
  });

  it("parses indexed environment variables KEEPER_SECRET_KEY_0, _1, etc.", () => {
    const key1 = createTestSecretKey(1);
    const key2 = createTestSecretKey(2);
    const key3 = createTestSecretKey(3);

    process.env.KEEPER_SECRET_KEY_0 = key1;
    process.env.KEEPER_SECRET_KEY_1 = key2;
    process.env.KEEPER_SECRET_KEY_2 = key3;

    const config = parseAccountPoolFromEnv();

    expect(config.accounts).toHaveLength(3);
    expect(config.accounts[0].secretKey).toBe(key1);
    expect(config.accounts[1].secretKey).toBe(key2);
    expect(config.accounts[2].secretKey).toBe(key3);
  });

  it("throws clear error when no accounts configured", () => {
    // Ensure no KEEPER_* env vars set
    delete process.env.KEEPER_SECRET_KEY;
    delete process.env.KEEPER_SECRET_KEYS;
    for (let i = 0; i < 10; i++) {
      delete process.env[`KEEPER_SECRET_KEY_${i}`];
    }

    expect(() => parseAccountPoolFromEnv()).toThrow(
      /No signing accounts configured/
    );
  });

  it("applies KEEPER_POOL_STRATEGY for round-robin", () => {
    const key1 = createTestSecretKey(1);
    const key2 = createTestSecretKey(2);

    process.env.KEEPER_SECRET_KEYS = `${key1},${key2}`;
    process.env.KEEPER_POOL_STRATEGY = "round-robin";

    const config = parseAccountPoolFromEnv();

    expect(config.strategy).toBe("round-robin");
  });

  it("applies KEEPER_POOL_STRATEGY for least-loaded", () => {
    const key1 = createTestSecretKey(1);
    const key2 = createTestSecretKey(2);

    process.env.KEEPER_SECRET_KEYS = `${key1},${key2}`;
    process.env.KEEPER_POOL_STRATEGY = "least-loaded";

    const config = parseAccountPoolFromEnv();

    expect(config.strategy).toBe("least-loaded");
  });

  it("defaults to round-robin when strategy not specified", () => {
    const key1 = createTestSecretKey(1);
    process.env.KEEPER_SECRET_KEYS = key1;

    const config = parseAccountPoolFromEnv();

    expect(config.strategy).toBe("round-robin");
  });

  it("prefers KEEPER_SECRET_KEYS over indexed vars", () => {
    const key1 = createTestSecretKey(1);
    const key2 = createTestSecretKey(2);
    const key3 = createTestSecretKey(3);
    const key4 = createTestSecretKey(4);

    process.env.KEEPER_SECRET_KEYS = `${key1},${key2}`;
    process.env.KEEPER_SECRET_KEY_0 = key3;
    process.env.KEEPER_SECRET_KEY_1 = key4;

    const config = parseAccountPoolFromEnv();

    expect(config.accounts).toHaveLength(2);
    expect(config.accounts[0].secretKey).toBe(key1);
    expect(config.accounts[1].secretKey).toBe(key2);
  });

  it("prefers indexed vars over KEEPER_SECRET_KEY", () => {
    const key1 = createTestSecretKey(1);
    const key2 = createTestSecretKey(2);
    const key3 = createTestSecretKey(3);

    process.env.KEEPER_SECRET_KEY = key1;
    process.env.KEEPER_SECRET_KEY_0 = key2;
    process.env.KEEPER_SECRET_KEY_1 = key3;

    const config = parseAccountPoolFromEnv();

    expect(config.accounts).toHaveLength(2);
    expect(config.accounts[0].secretKey).toBe(key2);
    expect(config.accounts[1].secretKey).toBe(key3);
  });

  it("backward compatible: KEEPER_SECRET_KEY still works as single account", () => {
    const key = createTestSecretKey(1);
    process.env.KEEPER_SECRET_KEY = key;

    const config = parseAccountPoolFromEnv();
    const pool = new AccountPool(config);

    expect(pool.size()).toBe(1);
  });
});

// ── getAccount and publicKeys Utility Tests ────────────────────────────

describe("AccountPool utility methods", () => {
  it("getAccount returns account by public key", () => {
    const key1 = createTestSecretKey(1);
    const key2 = createTestSecretKey(2);

    const keypair1 = Keypair.fromSecret(key1);

    const config: AccountPoolConfig = {
      accounts: [
        { secretKey: key1 },
        { secretKey: key2 },
      ],
    };

    const pool = new AccountPool(config);
    const account = pool.getAccount(keypair1.publicKey());

    expect(account).toBeDefined();
    expect(account!.publicKey).toBe(keypair1.publicKey());
  });

  it("getAccount returns undefined for unknown public key", () => {
    const key = createTestSecretKey(1);

    const config: AccountPoolConfig = {
      accounts: [{ secretKey: key }],
    };

    const pool = new AccountPool(config);
    const account = pool.getAccount("GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX");

    expect(account).toBeUndefined();
  });

  it("publicKeys returns all account public keys", () => {
    const key1 = createTestSecretKey(1);
    const key2 = createTestSecretKey(2);
    const key3 = createTestSecretKey(3);

    const keypair1 = Keypair.fromSecret(key1);
    const keypair2 = Keypair.fromSecret(key2);
    const keypair3 = Keypair.fromSecret(key3);

    const config: AccountPoolConfig = {
      accounts: [
        { secretKey: key1 },
        { secretKey: key2 },
        { secretKey: key3 },
      ],
    };

    const pool = new AccountPool(config);
    const publicKeys = pool.publicKeys();

    expect(publicKeys).toEqual([
      keypair1.publicKey(),
      keypair2.publicKey(),
      keypair3.publicKey(),
    ]);
  });
});
