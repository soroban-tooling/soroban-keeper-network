/**
 * Soroban Keeper Bot v2 — Configuration
 *
 * Responsibilities:
 *   1. Parse and validate all configuration values from the environment at
 *      startup (validateAndLoadConfig).
 *   2. Distinguish hot-reloadable values from restart-required ones and make
 *      that classification the single source of truth (CONFIG_SCHEMA).
 *   3. Re-read the environment before each round and apply any changes to
 *      hot-reloadable values immediately (reloadConfig).
 *   4. Detect changes to restart-required values and log them without
 *      applying them, preserving process integrity.
 *   5. Reject any invalid reload using the exact same validation pipeline as
 *      startup — there is deliberately no second validation path.
 *
 * Security
 *   Values declared with `secret: true` are never echoed in logs or error
 *   messages, following the same discipline as v1's requireEnv.
 *
 * Usage
 *   // Startup — exits process on any validation error.
 *   const cfg = await validateAndLoadConfig();
 *
 *   // Per-round reload — safe; returns a reload result object.
 *   const result = await reloadConfig(cfg);
 *   if (result.restartsRequired.length > 0) { ... }
 */

"use strict";

// ─────────────────────────────────────────────────────────────────────────────
// Reload behaviour constants
// ─────────────────────────────────────────────────────────────────────────────

/**
 * This value can be changed at runtime; the updated value takes effect on the
 * next evaluation round without restarting the process.
 */
const HOT_RELOADABLE = "hot-reloadable";

/**
 * Changing this value requires a process restart. The change is detected and
 * logged, but never applied to the running process.
 */
const RESTART_REQUIRED = "restart-required";

// ─────────────────────────────────────────────────────────────────────────────
// Configuration schema
//
// Every supported configuration key is declared here exactly once. The schema
// is the single source of truth for:
//   - which environment variable to read
//   - how to parse and validate it
//   - whether it is hot-reloadable or restart-required
//   - whether its value is sensitive (never logged)
//   - what default to use when the variable is absent
//
// Adding a new config key means adding one entry here and nowhere else.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @typedef {object} SchemaEntry
 * @property {string}   env             - Environment variable name.
 * @property {string}   reload          - HOT_RELOADABLE | RESTART_REQUIRED.
 * @property {boolean}  [secret]        - When true, value is never echoed in logs.
 * @property {Function} [parse]         - Raw string → typed value.
 * @property {{ fn: Function, reason: string }} [validate] - Typed-value check.
 * @property {*}        [fallback]      - Default when env var is absent/empty.
 */

/** @type {Record<string, SchemaEntry>} */
const CONFIG_SCHEMA = {
  // ── Restart-required ──────────────────────────────────────────────────────
  //
  // These values are consumed during process initialisation (RPC client,
  // Keypair, network passphrase). Changing them mid-run would leave the
  // process in an inconsistent state where, for example, the signing key
  // object and the configured KEEPER_SECRET_KEY diverge.

  network: {
    env: "NETWORK",
    reload: RESTART_REQUIRED,
    // Validation requires the SDK's isNetworkName; resolved at call time so
    // this file can be imported without the SDK being available.
    validate: null, // populated lazily in _buildNetworkValidation()
    fallback: "testnet",
  },

  registryContractId: {
    env: "REGISTRY_CONTRACT_ID",
    reload: RESTART_REQUIRED,
    validate: null, // populated lazily in _buildContractValidation()
  },

  secretKey: {
    env: "KEEPER_SECRET_KEY",
    reload: RESTART_REQUIRED,
    secret: true,
    validate: null, // populated lazily in _buildSecretKeyValidation()
    // Optional in dry-run mode — handled in validateAndLoadConfig.
    fallback: undefined,
  },

  dryRun: {
    env: "DRY_RUN",
    reload: RESTART_REQUIRED,
    parse: (v) => v.toLowerCase() === "true",
    fallback: false,
  },

  // ── Hot-reloadable ────────────────────────────────────────────────────────
  //
  // These values are consumed on every round (loop bound, threshold check,
  // retry policy, profitability check). Reading the current environment value
  // before each round and replacing the in-memory value is safe and takes
  // effect immediately on the following round.

  pollIntervalMs: {
    env: "POLL_INTERVAL_MS",
    reload: HOT_RELOADABLE,
    parse: (v) => parseInt(v, 10),
    validate: { fn: (v) => Number.isInteger(v) && v >= 1000, reason: "must be an integer >= 1000" },
    fallback: 10000,
  },

  withdrawThreshold: {
    env: "WITHDRAW_THRESHOLD",
    reload: HOT_RELOADABLE,
    parse: BigInt,
    validate: { fn: (v) => v >= 0n, reason: "must be a non-negative integer" },
    fallback: 10000000n,
  },

  maxTasksPerRound: {
    env: "MAX_TASKS_PER_ROUND",
    reload: HOT_RELOADABLE,
    parse: (v) => parseInt(v, 10),
    validate: { fn: (v) => Number.isInteger(v) && v >= 1, reason: "must be an integer >= 1" },
    fallback: 5,
  },

  maxRetries: {
    env: "MAX_RETRIES",
    reload: HOT_RELOADABLE,
    parse: (v) => parseInt(v, 10),
    validate: { fn: (v) => Number.isInteger(v) && v >= 0, reason: "must be an integer >= 0" },
    fallback: 3,
  },

  retryBaseMs: {
    env: "RETRY_BASE_MS",
    reload: HOT_RELOADABLE,
    parse: (v) => parseInt(v, 10),
    validate: { fn: (v) => Number.isInteger(v) && v > 0, reason: "must be an integer > 0" },
    fallback: 500,
  },

  expireStaleTasks: {
    env: "EXPIRE_STALE_TASKS",
    reload: HOT_RELOADABLE,
    parse: (v) => v.toLowerCase() === "true",
    fallback: true,
  },

  minProfitMarginStroops: {
    env: "MIN_PROFIT_MARGIN_STROOPS",
    reload: HOT_RELOADABLE,
    parse: BigInt,
    validate: { fn: (v) => v >= 0n, reason: "must be >= 0" },
    fallback: 0n,
  },

  simulateExecution: {
    env: "SIMULATE_EXECUTION",
    reload: HOT_RELOADABLE,
    parse: (v) => v.toLowerCase() === "true",
    fallback: false,
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Lazy validators — require the Stellar SDK at validation time, not at import
// time, so unit tests that do not load the SDK can still exercise the rest of
// this module.
// ─────────────────────────────────────────────────────────────────────────────

function _buildSecretKeyValidation() {
  const { StrKey } = require("@stellar/stellar-sdk");
  return {
    fn: StrKey.isValidEd25519SecretSeed,
    reason: "must be a valid secret key (starts with S...)",
  };
}

function _buildContractValidation() {
  const { StrKey } = require("@stellar/stellar-sdk");
  return {
    fn: StrKey.isValidContract,
    reason: "must be a valid contract ID (starts with C...)",
  };
}

async function _buildNetworkValidation() {
  // Dynamic import so this file stays CommonJS while the SDK is ESM.
  const { NETWORK_NAMES, isNetworkName } = await _loadSdk();
  return {
    fn: isNetworkName,
    reason: `must be one of: ${NETWORK_NAMES.join(", ")}`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// SDK loader — cached, same pattern as v1's loadSdk()
// ─────────────────────────────────────────────────────────────────────────────

let _sdk;
async function _loadSdk() {
  if (!_sdk) {
    _sdk = await import("@soroban-keeper-network/sdk");
  }
  return _sdk;
}

// ─────────────────────────────────────────────────────────────────────────────
// Validation primitive
//
// Same contract as v1's requireEnv, with one addition: instead of calling
// process.exit(1) on failure, it throws a ConfigValidationError so the reload
// path can catch and handle errors without terminating the process.
//
// validateAndLoadConfig() wraps this in a try/catch and exits on startup;
// reloadConfig() catches and logs, then retains the previous config.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Structured error thrown when a single configuration value fails validation.
 * Callers can inspect `fieldName` and `reason` for structured error handling.
 */
class ConfigValidationError extends Error {
  /**
   * @param {string} fieldName - Environment variable name (e.g. "POLL_INTERVAL_MS").
   * @param {string|null} displayValue - Value to show in the message, or null for secrets.
   * @param {string} reason - Human-readable constraint description.
   */
  constructor(fieldName, displayValue, reason) {
    const valuePart = displayValue != null ? `: ${displayValue}` : "";
    super(`Invalid ${fieldName}${valuePart} — ${reason}`);
    this.name = "ConfigValidationError";
    this.fieldName = fieldName;
    this.reason = reason;
  }
}

/**
 * Reads, parses, and validates a single environment variable.
 *
 * Mirrors v1's requireEnv signature exactly so validation rules are expressed
 * identically in both the startup and reload paths.
 *
 * @param {string} name              - Environment variable name.
 * @param {object} opts
 * @param {Function} [opts.parse]    - Transform raw string to typed value.
 * @param {{ fn: Function, reason: string }} [opts.validate] - Type-level check.
 * @param {boolean} [opts.secret]    - When true, value is omitted from errors.
 * @param {*} [opts.fallback]        - Returned when the variable is absent/empty.
 * @returns {*} Parsed and validated value.
 * @throws {ConfigValidationError} When the value is absent (no fallback) or invalid.
 */
function readEnv(name, { parse, validate, secret = false, fallback } = {}) {
  const raw = process.env[name];

  if (raw === undefined || raw === "") {
    if (fallback !== undefined) return fallback;
    throw new ConfigValidationError(name, null, "must be set");
  }

  let parsed;
  try {
    parsed = parse ? parse(raw) : raw;
  } catch (e) {
    throw new ConfigValidationError(name, secret ? null : raw, e.message);
  }

  if (validate && !validate.fn(parsed)) {
    throw new ConfigValidationError(name, secret ? null : raw, validate.reason);
  }

  return parsed;
}

// ─────────────────────────────────────────────────────────────────────────────
// Startup validation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Reads, validates, and returns the full configuration object.
 *
 * This is the startup path. Any validation failure is fatal: it logs the error
 * to stderr and calls process.exit(1), matching v1's behaviour exactly.
 *
 * @returns {Promise<object>} The validated, frozen-by-caller configuration.
 */
async function validateAndLoadConfig() {
  // Resolve the SDK-dependent validators before reading values so that
  // validation error messages reference the actual allowed network names.
  const networkValidate = await _buildNetworkValidation();
  const contractValidate = _buildContractValidation();
  const secretKeyValidate = _buildSecretKeyValidation();

  // Patch the lazy schema entries for this call.
  const resolvedSchema = {
    ...CONFIG_SCHEMA,
    network: { ...CONFIG_SCHEMA.network, validate: networkValidate },
    registryContractId: { ...CONFIG_SCHEMA.registryContractId, validate: contractValidate },
    secretKey: { ...CONFIG_SCHEMA.secretKey, validate: secretKeyValidate },
  };

  // Read dryRun first — it gates whether secretKey is required.
  let dryRun;
  try {
    dryRun = readEnv(
      resolvedSchema.dryRun.env,
      {
        parse: resolvedSchema.dryRun.parse,
        fallback: resolvedSchema.dryRun.fallback,
      }
    );
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }

  // Temporarily patch the secretKey fallback: in dry-run mode the key is
  // optional; in live mode it is required (no fallback).
  const secretKeyEntry = dryRun
    ? { ...resolvedSchema.secretKey, fallback: process.env.KEEPER_SECRET_KEY }
    : resolvedSchema.secretKey;
  const patchedSchema = { ...resolvedSchema, secretKey: secretKeyEntry, dryRun: { ...resolvedSchema.dryRun, _resolved: dryRun } };

  const config = {};

  for (const [key, entry] of Object.entries(patchedSchema)) {
    // dryRun was already read.
    if (key === "dryRun") {
      config.dryRun = dryRun;
      continue;
    }
    try {
      config[key] = readEnv(entry.env, {
        parse: entry.parse,
        validate: entry.validate,
        secret: entry.secret,
        fallback: entry.fallback,
      });
    } catch (e) {
      console.error(e.message);
      process.exit(1);
    }
  }

  // Attach reload metadata so callers can enumerate reloadable keys without
  // importing CONFIG_SCHEMA directly.
  config._reloadBehavior = _buildReloadBehaviorMap();

  return config;
}

/**
 * Returns a plain object mapping each config key to its reload behaviour
 * constant. Exposed for introspection (e.g. the CLI dump from issue 0265).
 *
 * @returns {Record<string, string>}
 */
function _buildReloadBehaviorMap() {
  const map = {};
  for (const [key, entry] of Object.entries(CONFIG_SCHEMA)) {
    map[key] = entry.reload;
  }
  return map;
}

// ─────────────────────────────────────────────────────────────────────────────
// Hot-reload
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @typedef {object} ConfigChange
 * @property {string} key         - Config key name (camelCase).
 * @property {string} env         - Environment variable name.
 * @property {*}      oldValue    - Previous value.
 * @property {*}      newValue    - New value.
 */

/**
 * @typedef {object} ReloadResult
 * @property {boolean}        success          - True when the reload completed without errors.
 * @property {ConfigChange[]} applied          - Hot-reloadable values that were updated.
 * @property {ConfigChange[]} restartsRequired - Restart-required values that changed.
 * @property {string[]}       validationErrors - Errors from the new environment (if any).
 */

/**
 * Reads the current environment, validates every hot-reloadable value with the
 * same rules used at startup, and applies changes to `config` in-place.
 *
 * Restart-required values that have changed are detected and logged but never
 * applied. Invalid values cause the entire reload to be rejected; `config`
 * is left unchanged so the process continues with the last known-good values.
 *
 * Calling this once per round — before the round's work begins — ensures that
 * updated hot-reloadable values take effect within one round of being changed.
 *
 * @param {object} config - The live config object returned by validateAndLoadConfig.
 * @param {object} [_resolvers] - Optional validator overrides, used by tests to
 *   avoid loading the Stellar SDK. Production code never passes this argument.
 *   Shape: { networkValidate, contractValidate, secretKeyValidate }
 * @returns {Promise<ReloadResult>}
 */
async function reloadConfig(config, _resolvers) {
  // Resolve the SDK-dependent validators for restart-required fields so that
  // change detection can parse the new raw values for comparison.
  // Injectable for testing — see the _resolvers parameter above.
  const networkValidate = (_resolvers && _resolvers.networkValidate) || await _buildNetworkValidation();
  const contractValidate = (_resolvers && _resolvers.contractValidate) || _buildContractValidation();
  const secretKeyValidate = (_resolvers && _resolvers.secretKeyValidate) || _buildSecretKeyValidation();

  const resolvedSchema = {
    ...CONFIG_SCHEMA,
    network: { ...CONFIG_SCHEMA.network, validate: networkValidate },
    registryContractId: { ...CONFIG_SCHEMA.registryContractId, validate: contractValidate },
    secretKey: { ...CONFIG_SCHEMA.secretKey, validate: secretKeyValidate },
  };

  // ── Step 1: Validate every hot-reloadable value from the current environment.
  //
  // All hot-reloadable values are validated first before any are applied.
  // A single invalid value aborts the entire reload so we never transition
  // into a partially-updated state.

  const pendingHot = {}; // key → newly parsed value, if changed
  const validationErrors = [];

  for (const [key, entry] of Object.entries(resolvedSchema)) {
    if (entry.reload !== HOT_RELOADABLE) continue;

    let newValue;
    try {
      newValue = readEnv(entry.env, {
        parse: entry.parse,
        validate: entry.validate,
        secret: entry.secret,
        fallback: entry.fallback,
      });
    } catch (e) {
      validationErrors.push(e.message);
      continue;
    }

    if (!_valuesEqual(config[key], newValue)) {
      pendingHot[key] = newValue;
    }
  }

  if (validationErrors.length > 0) {
    for (const msg of validationErrors) {
      console.error(`[config] reload rejected — ${msg}`);
    }
    console.error(
      `[config] reload aborted: retaining previous configuration (${validationErrors.length} validation error(s))`
    );
    return { success: false, applied: [], restartsRequired: [], validationErrors };
  }

  // ── Step 2: Detect restart-required changes.
  //
  // Restart-required values are parsed (where a parser exists) solely for
  // comparison; they are NEVER written back to `config`.

  const restartsRequired = [];

  for (const [key, entry] of Object.entries(resolvedSchema)) {
    if (entry.reload !== RESTART_REQUIRED) continue;

    // secretKey has no meaningful fallback in dry-run mode; handle the same
    // optional logic as startup by checking the existing config value.
    // In non-dry-run mode we also fall back to the running config's value so
    // that an unset KEEPER_SECRET_KEY doesn't produce a spurious "invalid"
    // warning — an operator who never changes the key leaves it unset in the
    // environment and the running config already holds the validated startup value.
    const effectiveFallback =
      key === "secretKey"
        ? config[key]
        : entry.fallback;

    let newValue;
    try {
      newValue = readEnv(entry.env, {
        parse: entry.parse,
        validate: entry.validate,
        secret: entry.secret,
        fallback: effectiveFallback,
      });
    } catch (_e) {
      // If the restart-required value is now invalid, log it but do not abort
      // the reload — hot-reloadable values have already been validated clean.
      // The operator must restart with a corrected value.
      const displayEnv = entry.env;
      console.warn(
        `[config] restart-required field ${displayEnv} is now invalid in the environment — ` +
        `the running process retains its startup value; restart to apply a corrected value`
      );
      continue;
    }

    if (!_valuesEqual(config[key], newValue)) {
      restartsRequired.push({
        key,
        env: entry.env,
        oldValue: _safeDisplayValue(key, config[key], entry),
        newValue: _safeDisplayValue(key, newValue, entry),
      });
    }
  }

  // ── Step 3: Log restart-required changes.

  for (const change of restartsRequired) {
    console.warn(
      `[config] restart required — ${change.env} changed ` +
      `(${change.oldValue} → ${change.newValue}); ` +
      `restart the process to apply this change`
    );
  }

  // ── Step 4: Apply hot-reloadable changes.

  const applied = [];

  for (const [key, newValue] of Object.entries(pendingHot)) {
    const entry = resolvedSchema[key];
    const oldValue = config[key];

    config[key] = newValue;

    applied.push({
      key,
      env: entry.env,
      oldValue: _safeDisplayValue(key, oldValue, entry),
      newValue: _safeDisplayValue(key, newValue, entry),
    });

    console.log(
      `[config] ${entry.env} updated: ${_safeDisplayValue(key, oldValue, entry)} → ${_safeDisplayValue(key, newValue, entry)}`
    );
  }

  if (applied.length > 0 || restartsRequired.length > 0) {
    const summary = [];
    if (applied.length > 0) summary.push(`${applied.length} applied`);
    if (restartsRequired.length > 0) summary.push(`${restartsRequired.length} pending restart`);
    console.log(`[config] reload complete (${summary.join(", ")})`);
  }

  return { success: true, applied, restartsRequired, validationErrors: [] };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compares two config values for equality. Handles BigInt, boolean, number,
 * and string without relying on reference identity.
 */
function _valuesEqual(a, b) {
  if (typeof a === "bigint" || typeof b === "bigint") {
    return BigInt(a) === BigInt(b);
  }
  return a === b;
}

/**
 * Returns a display-safe representation of a config value.
 * Secret values are replaced with the string "<redacted>" so that change
 * logs never expose credentials, even in a "old → new" diff.
 *
 * @param {string} _key   - Config key (unused; entry carries all needed info).
 * @param {*} value       - The value to display.
 * @param {SchemaEntry} entry - Schema entry for this key.
 * @returns {string}
 */
function _safeDisplayValue(_key, value, entry) {
  if (entry.secret) return "<redacted>";
  if (value === undefined || value === null) return String(value);
  return String(value);
}

/**
 * Returns the list of keys classified as hot-reloadable.
 * Useful for documentation and tests.
 *
 * @returns {string[]}
 */
function hotReloadableKeys() {
  return Object.entries(CONFIG_SCHEMA)
    .filter(([, e]) => e.reload === HOT_RELOADABLE)
    .map(([k]) => k);
}

/**
 * Returns the list of keys classified as restart-required.
 * Useful for documentation and tests.
 *
 * @returns {string[]}
 */
function restartRequiredKeys() {
  return Object.entries(CONFIG_SCHEMA)
    .filter(([, e]) => e.reload === RESTART_REQUIRED)
    .map(([k]) => k);
}

// ─────────────────────────────────────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  // Core API
  validateAndLoadConfig,
  reloadConfig,
  // Schema introspection
  CONFIG_SCHEMA,
  HOT_RELOADABLE,
  RESTART_REQUIRED,
  hotReloadableKeys,
  restartRequiredKeys,
  // Exposed for testing — not part of the public operational API
  readEnv,
  ConfigValidationError,
  _valuesEqual,
  _safeDisplayValue,
};
