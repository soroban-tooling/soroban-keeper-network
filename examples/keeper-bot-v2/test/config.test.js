/**
 * Test suite for keeper-bot-v2 configuration (src/config.js).
 *
 * Coverage:
 *   A. Classification — every key has an explicit reload behaviour.
 *   B. Hot-reload success — updated values are applied within one round.
 *   C. Restart-required change detection — changes are logged, not applied.
 *   D. Validation consistency — startup and reload use the same pipeline.
 *   E. Invalid reload rejection — previous config is retained on bad values.
 *   F. Security — secrets are never present in change log output.
 *
 * These tests do not load the Stellar SDK or make network calls. All
 * validators that require the SDK (network, registryContractId, secretKey)
 * are exercised through the exported readEnv / ConfigValidationError
 * primitives to confirm the validation contract is identical between paths.
 */

"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

const {
  CONFIG_SCHEMA,
  HOT_RELOADABLE,
  RESTART_REQUIRED,
  hotReloadableKeys,
  restartRequiredKeys,
  readEnv,
  ConfigValidationError,
  _valuesEqual,
  _safeDisplayValue,
  reloadConfig,
} = require("../src/config.js");

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Save and restore process.env around each test. */
let savedEnv;
beforeEach(() => {
  savedEnv = { ...process.env };
});
afterEach(() => {
  // Restore exactly — delete keys added by the test, restore keys changed.
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) delete process.env[key];
  }
  Object.assign(process.env, savedEnv);
});

// Valid IDs used consistently across tests.
const VALID_CONTRACT_ID = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";
const VALID_SECRET_KEY  = "SBGWKM3CD4IL47QN6X54N6Y33T3JDNVI6AIJ6CD5IM47HG3IG4O36XCU";
const ALT_CONTRACT_ID   = "CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBAE4";

/**
 * Mock validator resolvers that stand in for the Stellar SDK validators.
 * This matches the injectable pattern v1's withRetry uses for its sleep
 * function — the production code never passes these; tests do to avoid
 * needing npm install to have completed.
 *
 * The validation logic intentionally mirrors what the real SDK validators
 * enforce so that the tests cover the same contract:
 *   - network: must be testnet | futurenet | mainnet
 *   - registryContractId: must start with C and be 56 chars
 *   - secretKey: must start with S and be 56 chars
 */
const VALID_NETWORKS = new Set(["testnet", "futurenet", "mainnet"]);
const mockResolvers = {
  networkValidate: {
    fn: (v) => VALID_NETWORKS.has(v),
    reason: "must be one of: testnet, futurenet, mainnet",
  },
  contractValidate: {
    fn: (v) => typeof v === "string" && v.startsWith("C") && v.length === 56,
    reason: "must be a valid contract ID (starts with C...)",
  },
  secretKeyValidate: {
    fn: (v) => typeof v === "string" && v.startsWith("S") && v.length === 56,
    reason: "must be a valid secret key (starts with S...)",
  },
};

/**
 * Builds a minimal valid config object whose keys match the defaults in
 * CONFIG_SCHEMA. Restart-required keys are set to sentinel values that are
 * never compared during hot-reload tests unless a test explicitly changes them.
 */
function makeBaseConfig(overrides = {}) {
  return {
    network: "testnet",
    registryContractId: VALID_CONTRACT_ID,
    secretKey: VALID_SECRET_KEY,
    dryRun: false,
    pollIntervalMs: 10000,
    withdrawThreshold: 10000000n,
    maxTasksPerRound: 5,
    maxRetries: 3,
    retryBaseMs: 500,
    expireStaleTasks: true,
    minProfitMarginStroops: 0n,
    simulateExecution: false,
    _reloadBehavior: Object.fromEntries(
      Object.entries(CONFIG_SCHEMA).map(([k, e]) => [k, e.reload])
    ),
    ...overrides,
  };
}

/**
 * Sets the environment variables for all hot-reloadable keys to their
 * default values so that reloadConfig() finds no changes unless a test
 * explicitly overrides one.
 */
function setDefaultHotEnv() {
  process.env.POLL_INTERVAL_MS = "10000";
  process.env.WITHDRAW_THRESHOLD = "10000000";
  process.env.MAX_TASKS_PER_ROUND = "5";
  process.env.MAX_RETRIES = "3";
  process.env.RETRY_BASE_MS = "500";
  process.env.EXPIRE_STALE_TASKS = "true";
  process.env.MIN_PROFIT_MARGIN_STROOPS = "0";
  process.env.SIMULATE_EXECUTION = "false";
}

/**
 * Sets the restart-required environment variables to values that match the
 * base config so reloadConfig() detects no restart-required changes.
 */
function setDefaultRestartEnv() {
  process.env.NETWORK = "testnet";
  process.env.REGISTRY_CONTRACT_ID = VALID_CONTRACT_ID;
  process.env.DRY_RUN = "false";
  // KEEPER_SECRET_KEY left unset — readEnv uses the config's existing value
  // as the fallback in non-dry-run mode.
}

/**
 * Convenience: call reloadConfig with the mock resolvers injected so tests
 * never need the Stellar SDK installed. Matches the injectable-dependency
 * pattern v1's withRetry uses for its sleepFn.
 */
function reload(config) {
  return reloadConfig(config, mockResolvers);
}

// ─────────────────────────────────────────────────────────────────────────────
// A. Configuration classification
// ─────────────────────────────────────────────────────────────────────────────

describe("A. Configuration classification", () => {
  it("every key in CONFIG_SCHEMA has an explicit reload behaviour", () => {
    const valid = new Set([HOT_RELOADABLE, RESTART_REQUIRED]);
    for (const [key, entry] of Object.entries(CONFIG_SCHEMA)) {
      assert.ok(
        valid.has(entry.reload),
        `CONFIG_SCHEMA["${key}"].reload must be HOT_RELOADABLE or RESTART_REQUIRED, got "${entry.reload}"`
      );
    }
  });

  it("hotReloadableKeys() returns only keys declared HOT_RELOADABLE", () => {
    const keys = hotReloadableKeys();
    for (const key of keys) {
      assert.equal(CONFIG_SCHEMA[key].reload, HOT_RELOADABLE, `${key} should be HOT_RELOADABLE`);
    }
    // Verify none were missed.
    const schemaHot = Object.entries(CONFIG_SCHEMA)
      .filter(([, e]) => e.reload === HOT_RELOADABLE)
      .map(([k]) => k);
    assert.deepEqual(keys.sort(), schemaHot.sort());
  });

  it("restartRequiredKeys() returns only keys declared RESTART_REQUIRED", () => {
    const keys = restartRequiredKeys();
    for (const key of keys) {
      assert.equal(CONFIG_SCHEMA[key].reload, RESTART_REQUIRED, `${key} should be RESTART_REQUIRED`);
    }
    const schemaRestart = Object.entries(CONFIG_SCHEMA)
      .filter(([, e]) => e.reload === RESTART_REQUIRED)
      .map(([k]) => k);
    assert.deepEqual(keys.sort(), schemaRestart.sort());
  });

  it("network is restart-required", () => {
    assert.equal(CONFIG_SCHEMA.network.reload, RESTART_REQUIRED);
  });

  it("registryContractId is restart-required", () => {
    assert.equal(CONFIG_SCHEMA.registryContractId.reload, RESTART_REQUIRED);
  });

  it("secretKey is restart-required", () => {
    assert.equal(CONFIG_SCHEMA.secretKey.reload, RESTART_REQUIRED);
  });

  it("dryRun is restart-required", () => {
    assert.equal(CONFIG_SCHEMA.dryRun.reload, RESTART_REQUIRED);
  });

  it("pollIntervalMs is hot-reloadable", () => {
    assert.equal(CONFIG_SCHEMA.pollIntervalMs.reload, HOT_RELOADABLE);
  });

  it("withdrawThreshold is hot-reloadable", () => {
    assert.equal(CONFIG_SCHEMA.withdrawThreshold.reload, HOT_RELOADABLE);
  });

  it("maxTasksPerRound is hot-reloadable", () => {
    assert.equal(CONFIG_SCHEMA.maxTasksPerRound.reload, HOT_RELOADABLE);
  });

  it("maxRetries is hot-reloadable", () => {
    assert.equal(CONFIG_SCHEMA.maxRetries.reload, HOT_RELOADABLE);
  });

  it("retryBaseMs is hot-reloadable", () => {
    assert.equal(CONFIG_SCHEMA.retryBaseMs.reload, HOT_RELOADABLE);
  });

  it("expireStaleTasks is hot-reloadable", () => {
    assert.equal(CONFIG_SCHEMA.expireStaleTasks.reload, HOT_RELOADABLE);
  });

  it("minProfitMarginStroops is hot-reloadable", () => {
    assert.equal(CONFIG_SCHEMA.minProfitMarginStroops.reload, HOT_RELOADABLE);
  });

  it("simulateExecution is hot-reloadable", () => {
    assert.equal(CONFIG_SCHEMA.simulateExecution.reload, HOT_RELOADABLE);
  });

  it("hot-reloadable set and restart-required set are disjoint", () => {
    const hot = new Set(hotReloadableKeys());
    for (const key of restartRequiredKeys()) {
      assert.ok(!hot.has(key), `${key} appears in both categories`);
    }
  });

  it("union of both sets equals all keys in CONFIG_SCHEMA", () => {
    const all = new Set([...hotReloadableKeys(), ...restartRequiredKeys()]);
    for (const key of Object.keys(CONFIG_SCHEMA)) {
      assert.ok(all.has(key), `${key} is missing from both categories`);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// B. Hot-reload success
// ─────────────────────────────────────────────────────────────────────────────

describe("B. Hot-reload success", () => {
  it("a changed pollIntervalMs is applied and reported", async () => {
    const config = makeBaseConfig({ pollIntervalMs: 10000 });
    setDefaultHotEnv();
    setDefaultRestartEnv();
    process.env.POLL_INTERVAL_MS = "20000";

    const result = await reload(config);

    assert.equal(result.success, true);
    assert.equal(config.pollIntervalMs, 20000, "config must be updated in-place");
    assert.equal(result.applied.length, 1);
    assert.equal(result.applied[0].key, "pollIntervalMs");
    assert.equal(result.applied[0].oldValue, "10000");
    assert.equal(result.applied[0].newValue, "20000");
  });

  it("a changed minProfitMarginStroops (profitability threshold) is applied", async () => {
    const config = makeBaseConfig({ minProfitMarginStroops: 0n });
    setDefaultHotEnv();
    setDefaultRestartEnv();
    process.env.MIN_PROFIT_MARGIN_STROOPS = "500000";

    const result = await reload(config);

    assert.equal(result.success, true);
    assert.equal(config.minProfitMarginStroops, 500000n);
    const change = result.applied.find((c) => c.key === "minProfitMarginStroops");
    assert.ok(change, "minProfitMarginStroops should appear in applied changes");
    assert.equal(change.newValue, "500000");
  });

  it("a changed maxTasksPerRound (concurrency limit) is applied", async () => {
    const config = makeBaseConfig({ maxTasksPerRound: 5 });
    setDefaultHotEnv();
    setDefaultRestartEnv();
    process.env.MAX_TASKS_PER_ROUND = "10";

    const result = await reload(config);

    assert.equal(result.success, true);
    assert.equal(config.maxTasksPerRound, 10);
    const change = result.applied.find((c) => c.key === "maxTasksPerRound");
    assert.ok(change);
  });

  it("a changed withdrawThreshold is applied", async () => {
    const config = makeBaseConfig({ withdrawThreshold: 10000000n });
    setDefaultHotEnv();
    setDefaultRestartEnv();
    process.env.WITHDRAW_THRESHOLD = "50000000";

    const result = await reload(config);

    assert.equal(result.success, true);
    assert.equal(config.withdrawThreshold, 50000000n);
  });

  it("a changed maxRetries is applied", async () => {
    const config = makeBaseConfig({ maxRetries: 3 });
    setDefaultHotEnv();
    setDefaultRestartEnv();
    process.env.MAX_RETRIES = "5";

    const result = await reload(config);

    assert.equal(result.success, true);
    assert.equal(config.maxRetries, 5);
  });

  it("a changed retryBaseMs is applied", async () => {
    const config = makeBaseConfig({ retryBaseMs: 500 });
    setDefaultHotEnv();
    setDefaultRestartEnv();
    process.env.RETRY_BASE_MS = "1000";

    const result = await reload(config);

    assert.equal(result.success, true);
    assert.equal(config.retryBaseMs, 1000);
  });

  it("a changed expireStaleTasks is applied", async () => {
    const config = makeBaseConfig({ expireStaleTasks: true });
    setDefaultHotEnv();
    setDefaultRestartEnv();
    process.env.EXPIRE_STALE_TASKS = "false";

    const result = await reload(config);

    assert.equal(result.success, true);
    assert.equal(config.expireStaleTasks, false);
  });

  it("a changed simulateExecution (fee ceiling proxy) is applied", async () => {
    const config = makeBaseConfig({ simulateExecution: false });
    setDefaultHotEnv();
    setDefaultRestartEnv();
    process.env.SIMULATE_EXECUTION = "true";

    const result = await reload(config);

    assert.equal(result.success, true);
    assert.equal(config.simulateExecution, true);
  });

  it("no changes results in an empty applied list and success", async () => {
    const config = makeBaseConfig();
    setDefaultHotEnv();
    setDefaultRestartEnv();

    const result = await reload(config);

    assert.equal(result.success, true);
    assert.equal(result.applied.length, 0);
    assert.equal(result.restartsRequired.length, 0);
  });

  it("multiple hot-reloadable changes are all applied in one reload", async () => {
    const config = makeBaseConfig({ pollIntervalMs: 10000, maxRetries: 3, retryBaseMs: 500 });
    setDefaultHotEnv();
    setDefaultRestartEnv();
    process.env.POLL_INTERVAL_MS = "30000";
    process.env.MAX_RETRIES = "7";
    process.env.RETRY_BASE_MS = "250";

    const result = await reload(config);

    assert.equal(result.success, true);
    assert.equal(config.pollIntervalMs, 30000);
    assert.equal(config.maxRetries, 7);
    assert.equal(config.retryBaseMs, 250);
    assert.equal(result.applied.length, 3);
  });

  it("rapid successive reloads converge to final env value", async () => {
    const config = makeBaseConfig({ minProfitMarginStroops: 0n });
    setDefaultHotEnv();
    setDefaultRestartEnv();

    process.env.MIN_PROFIT_MARGIN_STROOPS = "100000";
    await reload(config);
    assert.equal(config.minProfitMarginStroops, 100000n);

    process.env.MIN_PROFIT_MARGIN_STROOPS = "200000";
    await reload(config);
    assert.equal(config.minProfitMarginStroops, 200000n);

    process.env.MIN_PROFIT_MARGIN_STROOPS = "50000";
    await reload(config);
    assert.equal(config.minProfitMarginStroops, 50000n);
  });

  it("change record carries env variable name alongside the camelCase key", async () => {
    const config = makeBaseConfig({ pollIntervalMs: 10000 });
    setDefaultHotEnv();
    setDefaultRestartEnv();
    process.env.POLL_INTERVAL_MS = "15000";

    const result = await reload(config);

    const change = result.applied.find((c) => c.key === "pollIntervalMs");
    assert.ok(change);
    assert.equal(change.env, "POLL_INTERVAL_MS");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// C. Restart-required change detection
// ─────────────────────────────────────────────────────────────────────────────

describe("C. Restart-required change detection", () => {
  it("a network change is detected and reported", async () => {
    const config = makeBaseConfig({ network: "testnet" });
    setDefaultHotEnv();
    setDefaultRestartEnv();
    process.env.NETWORK = "mainnet";

    const result = await reload(config);

    assert.equal(result.success, true, "reload should succeed even with restart-required changes");
    const change = result.restartsRequired.find((c) => c.key === "network");
    assert.ok(change, "network change must appear in restartsRequired");
    assert.equal(change.oldValue, "testnet");
    assert.equal(change.newValue, "mainnet");
  });

  it("a network change is NOT applied to the running config", async () => {
    const config = makeBaseConfig({ network: "testnet" });
    setDefaultHotEnv();
    setDefaultRestartEnv();
    process.env.NETWORK = "mainnet";

    await reload(config);

    assert.equal(config.network, "testnet", "config.network must remain unchanged");
  });

  it("a registryContractId change is detected and not applied", async () => {
    const original = VALID_CONTRACT_ID;
    const changed = ALT_CONTRACT_ID;
    const config = makeBaseConfig({ registryContractId: original });
    setDefaultHotEnv();
    setDefaultRestartEnv();
    process.env.REGISTRY_CONTRACT_ID = changed;

    const result = await reload(config);

    const change = result.restartsRequired.find((c) => c.key === "registryContractId");
    assert.ok(change, "registryContractId change must be reported");
    assert.equal(config.registryContractId, original, "must not be applied");
  });

  it("a dryRun change is detected and not applied", async () => {
    const config = makeBaseConfig({ dryRun: false });
    setDefaultHotEnv();
    setDefaultRestartEnv();
    process.env.DRY_RUN = "true";

    const result = await reload(config);

    const change = result.restartsRequired.find((c) => c.key === "dryRun");
    assert.ok(change, "dryRun change must be reported");
    assert.equal(config.dryRun, false, "must not be applied");
  });

  it("restart-required change record carries env variable name", async () => {
    const config = makeBaseConfig({ network: "testnet" });
    setDefaultHotEnv();
    setDefaultRestartEnv();
    process.env.NETWORK = "mainnet";

    const result = await reload(config);

    const change = result.restartsRequired.find((c) => c.key === "network");
    assert.ok(change);
    assert.equal(change.env, "NETWORK");
  });

  it("simultaneous hot-reloadable and restart-required changes are both reported", async () => {
    const config = makeBaseConfig({ network: "testnet", maxRetries: 3 });
    setDefaultHotEnv();
    setDefaultRestartEnv();
    process.env.NETWORK = "mainnet";
    process.env.MAX_RETRIES = "7";

    const result = await reload(config);

    assert.equal(result.success, true);
    assert.ok(result.restartsRequired.find((c) => c.key === "network"));
    assert.ok(result.applied.find((c) => c.key === "maxRetries"));
    // Hot change applied; restart-required not applied.
    assert.equal(config.maxRetries, 7);
    assert.equal(config.network, "testnet");
  });

  it("changes are not silently ignored: a changed network produces a non-empty restartsRequired", async () => {
    const config = makeBaseConfig({ network: "testnet" });
    setDefaultHotEnv();
    setDefaultRestartEnv();
    process.env.NETWORK = "futurenet";

    const result = await reload(config);

    assert.ok(result.restartsRequired.length > 0, "must not silently ignore restart-required change");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// D. Validation consistency — startup and reload use the same rules
// ─────────────────────────────────────────────────────────────────────────────

describe("D. Validation consistency", () => {
  // These tests exercise readEnv directly with the exact validators from the
  // schema. The same function and the same validator objects are used by both
  // validateAndLoadConfig() and reloadConfig(), so any failure here applies
  // equally to both paths.

  it("pollIntervalMs: valid value passes in both paths", () => {
    const entry = CONFIG_SCHEMA.pollIntervalMs;
    assert.doesNotThrow(() =>
      readEnv(entry.env, { parse: entry.parse, validate: entry.validate, fallback: entry.fallback })
    );
    process.env[entry.env] = "5000";
    const val = readEnv(entry.env, { parse: entry.parse, validate: entry.validate });
    assert.equal(val, 5000);
  });

  it("pollIntervalMs: value below minimum (500) fails the same constraint in both paths", () => {
    const entry = CONFIG_SCHEMA.pollIntervalMs;
    process.env[entry.env] = "500";
    assert.throws(
      () => readEnv(entry.env, { parse: entry.parse, validate: entry.validate }),
      ConfigValidationError
    );
  });

  it("maxTasksPerRound: zero fails the same constraint in both paths", () => {
    const entry = CONFIG_SCHEMA.maxTasksPerRound;
    process.env[entry.env] = "0";
    assert.throws(
      () => readEnv(entry.env, { parse: entry.parse, validate: entry.validate }),
      ConfigValidationError
    );
  });

  it("maxRetries: negative value fails the same constraint in both paths", () => {
    const entry = CONFIG_SCHEMA.maxRetries;
    process.env[entry.env] = "-1";
    assert.throws(
      () => readEnv(entry.env, { parse: entry.parse, validate: entry.validate }),
      ConfigValidationError
    );
  });

  it("retryBaseMs: zero fails in both paths", () => {
    const entry = CONFIG_SCHEMA.retryBaseMs;
    process.env[entry.env] = "0";
    assert.throws(
      () => readEnv(entry.env, { parse: entry.parse, validate: entry.validate }),
      ConfigValidationError
    );
  });

  it("withdrawThreshold: negative value fails in both paths", () => {
    const entry = CONFIG_SCHEMA.withdrawThreshold;
    process.env[entry.env] = "-1";
    assert.throws(
      () => readEnv(entry.env, { parse: entry.parse, validate: entry.validate }),
      ConfigValidationError
    );
  });

  it("minProfitMarginStroops: negative value fails in both paths", () => {
    const entry = CONFIG_SCHEMA.minProfitMarginStroops;
    process.env[entry.env] = "-1";
    assert.throws(
      () => readEnv(entry.env, { parse: entry.parse, validate: entry.validate }),
      ConfigValidationError
    );
  });

  it("ConfigValidationError carries the field name for structured handling", () => {
    const entry = CONFIG_SCHEMA.pollIntervalMs;
    process.env[entry.env] = "0";
    let caught;
    try {
      readEnv(entry.env, { parse: entry.parse, validate: entry.validate });
    } catch (e) {
      caught = e;
    }
    assert.ok(caught instanceof ConfigValidationError);
    assert.equal(caught.fieldName, "POLL_INTERVAL_MS");
  });

  it("error message format is the same for startup-path and reload-path calls", () => {
    const entry = CONFIG_SCHEMA.maxTasksPerRound;
    process.env[entry.env] = "0";
    let caught;
    try {
      readEnv(entry.env, { parse: entry.parse, validate: entry.validate });
    } catch (e) {
      caught = e;
    }
    assert.ok(caught);
    assert.ok(caught.message.includes("MAX_TASKS_PER_ROUND"), "field name in message");
    assert.ok(caught.message.includes("must be"), "constraint in message");
  });

  it("absent required value fails with 'must be set' in both paths", () => {
    delete process.env.MAX_TASKS_PER_ROUND;
    const entry = CONFIG_SCHEMA.maxTasksPerRound;
    // No fallback supplied — simulates a missing required value.
    assert.throws(
      () => readEnv(entry.env, { parse: entry.parse, validate: entry.validate }),
      (e) => e instanceof ConfigValidationError && e.message.includes("must be set")
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// E. Invalid reload rejection
// ─────────────────────────────────────────────────────────────────────────────

describe("E. Invalid reload rejection", () => {
  it("invalid pollIntervalMs (below minimum) causes reload to be rejected", async () => {
    const config = makeBaseConfig({ pollIntervalMs: 10000 });
    setDefaultHotEnv();
    setDefaultRestartEnv();
    process.env.POLL_INTERVAL_MS = "500"; // invalid — below 1000

    const result = await reload(config);

    assert.equal(result.success, false);
    assert.equal(config.pollIntervalMs, 10000, "previous value must be retained");
    assert.ok(result.validationErrors.length > 0);
  });

  it("invalid maxTasksPerRound (zero) causes reload to be rejected", async () => {
    const config = makeBaseConfig({ maxTasksPerRound: 5 });
    setDefaultHotEnv();
    setDefaultRestartEnv();
    process.env.MAX_TASKS_PER_ROUND = "0";

    const result = await reload(config);

    assert.equal(result.success, false);
    assert.equal(config.maxTasksPerRound, 5, "previous value must be retained");
  });

  it("invalid minProfitMarginStroops (negative) causes reload to be rejected", async () => {
    const config = makeBaseConfig({ minProfitMarginStroops: 100n });
    setDefaultHotEnv();
    setDefaultRestartEnv();
    process.env.MIN_PROFIT_MARGIN_STROOPS = "-1";

    const result = await reload(config);

    assert.equal(result.success, false);
    assert.equal(config.minProfitMarginStroops, 100n, "previous value must be retained");
  });

  it("invalid retryBaseMs (zero) causes reload to be rejected", async () => {
    const config = makeBaseConfig({ retryBaseMs: 500 });
    setDefaultHotEnv();
    setDefaultRestartEnv();
    process.env.RETRY_BASE_MS = "0";

    const result = await reload(config);

    assert.equal(result.success, false);
    assert.equal(config.retryBaseMs, 500);
  });

  it("invalid maxRetries (negative) causes reload to be rejected", async () => {
    const config = makeBaseConfig({ maxRetries: 3 });
    setDefaultHotEnv();
    setDefaultRestartEnv();
    process.env.MAX_RETRIES = "-1";

    const result = await reload(config);

    assert.equal(result.success, false);
    assert.equal(config.maxRetries, 3);
  });

  it("invalid withdrawThreshold (negative) causes reload to be rejected", async () => {
    const config = makeBaseConfig({ withdrawThreshold: 10000000n });
    setDefaultHotEnv();
    setDefaultRestartEnv();
    process.env.WITHDRAW_THRESHOLD = "-100";

    const result = await reload(config);

    assert.equal(result.success, false);
    assert.equal(config.withdrawThreshold, 10000000n);
  });

  it("a rejection leaves ALL hot-reloadable values unchanged, including valid ones", async () => {
    // If one value is invalid, no values should be applied — not even the
    // valid ones. This prevents partial-update states.
    const config = makeBaseConfig({ pollIntervalMs: 10000, maxRetries: 3 });
    setDefaultHotEnv();
    setDefaultRestartEnv();
    process.env.POLL_INTERVAL_MS = "500"; // invalid
    process.env.MAX_RETRIES = "7";        // valid change — must NOT be applied

    const result = await reload(config);

    assert.equal(result.success, false);
    assert.equal(config.pollIntervalMs, 10000, "invalid field: must retain old value");
    assert.equal(config.maxRetries, 3, "valid field in same reload: must also retain old value");
    assert.equal(result.applied.length, 0, "no changes must be applied on rejection");
  });

  it("validation errors are reported in the result object", async () => {
    const config = makeBaseConfig();
    setDefaultHotEnv();
    setDefaultRestartEnv();
    process.env.POLL_INTERVAL_MS = "0";

    const result = await reload(config);

    assert.equal(result.success, false);
    assert.ok(Array.isArray(result.validationErrors));
    assert.ok(result.validationErrors.length > 0);
    assert.ok(
      result.validationErrors.some((e) => e.includes("POLL_INTERVAL_MS")),
      "error must name the offending field"
    );
  });

  it("runtime is not corrupted after a rejected reload", async () => {
    const config = makeBaseConfig({ pollIntervalMs: 10000, minProfitMarginStroops: 1000n });
    setDefaultHotEnv();
    setDefaultRestartEnv();
    process.env.POLL_INTERVAL_MS = "0"; // reject

    await reload(config);

    // Subsequent valid reload must succeed and apply changes correctly.
    process.env.POLL_INTERVAL_MS = "15000";
    process.env.MIN_PROFIT_MARGIN_STROOPS = "5000";
    const result = await reload(config);

    assert.equal(result.success, true);
    assert.equal(config.pollIntervalMs, 15000);
    assert.equal(config.minProfitMarginStroops, 5000n);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// F. Security — secrets never appear in change output
// ─────────────────────────────────────────────────────────────────────────────

describe("F. Security — secrets never appear in change output", () => {
  it("secretKey is marked secret in CONFIG_SCHEMA", () => {
    assert.equal(CONFIG_SCHEMA.secretKey.secret, true);
  });

  it("_safeDisplayValue returns '<redacted>' for secret entries", () => {
    const entry = CONFIG_SCHEMA.secretKey;
    const display = _safeDisplayValue("secretKey", "SBGWKM3CD4IL47QN6X54N6Y33T3JDNVI6AIJ6CD5IM47HG3IG4O36XCU", entry);
    assert.equal(display, "<redacted>");
  });

  it("_safeDisplayValue returns string form for non-secret entries", () => {
    const entry = CONFIG_SCHEMA.pollIntervalMs;
    assert.equal(_safeDisplayValue("pollIntervalMs", 10000, entry), "10000");
  });

  it("secretKey value never appears in a restart-required change record", async () => {
    const realSecret = "SBGWKM3CD4IL47QN6X54N6Y33T3JDNVI6AIJ6CD5IM47HG3IG4O36XCU";
    // 56-char S-prefixed key so the mock validator accepts it and a change
    // record is actually produced, exercising the redaction path.
    const newSecret  = "SDHOSGKDEXAMPLEKEYAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB";
    const config = makeBaseConfig({ secretKey: realSecret });
    setDefaultHotEnv();
    setDefaultRestartEnv();
    process.env.KEEPER_SECRET_KEY = newSecret;

    const logs = [];
    const original = console.warn;
    console.warn = (...args) => logs.push(args.join(" "));
    let result;
    try {
      result = await reload(config);
    } finally {
      console.warn = original;
    }

    // The change may or may not be detected (depends on whether readEnv
    // validates the new value), but in NO case should either key appear.
    const allOutput = logs.join("\n");
    assert.ok(!allOutput.includes(realSecret), "old secret must never appear in logs");
    assert.ok(!allOutput.includes(newSecret), "new secret must never appear in logs");

    // If a change record was produced, its oldValue/newValue must be redacted.
    for (const change of (result ? result.restartsRequired : [])) {
      if (change.key === "secretKey") {
        assert.equal(change.oldValue, "<redacted>", "oldValue must be redacted");
        assert.equal(change.newValue, "<redacted>", "newValue must be redacted");
      }
    }
  });

  it("readEnv omits the value from the error when secret=true", () => {
    const secret = "SBSECRETKEYAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    process.env.KEEPER_SECRET_KEY = secret;
    let caught;
    try {
      readEnv("KEEPER_SECRET_KEY", {
        secret: true,
        validate: { fn: () => false, reason: "deliberate test failure" },
      });
    } catch (e) {
      caught = e;
    }
    assert.ok(caught instanceof ConfigValidationError);
    assert.ok(!caught.message.includes(secret), "secret value must not appear in error message");
    assert.ok(caught.message.includes("KEEPER_SECRET_KEY"), "field name must appear");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// G. _valuesEqual edge cases
// ─────────────────────────────────────────────────────────────────────────────

describe("G. _valuesEqual edge cases", () => {
  it("equal numbers", () => assert.ok(_valuesEqual(1000, 1000)));
  it("unequal numbers", () => assert.ok(!_valuesEqual(1000, 2000)));
  it("equal booleans", () => assert.ok(_valuesEqual(true, true)));
  it("unequal booleans", () => assert.ok(!_valuesEqual(true, false)));
  it("equal BigInt", () => assert.ok(_valuesEqual(100n, 100n)));
  it("unequal BigInt", () => assert.ok(!_valuesEqual(100n, 200n)));
  it("equal string", () => assert.ok(_valuesEqual("testnet", "testnet")));
  it("unequal string", () => assert.ok(!_valuesEqual("testnet", "mainnet")));
  it("BigInt vs number with same value", () => assert.ok(_valuesEqual(100n, 100)));
  it("undefined vs undefined", () => assert.ok(_valuesEqual(undefined, undefined)));
});
