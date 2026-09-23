"use strict";

require("dotenv").config();

function parseEnv(name, { parse, validate, fallback, required = false }) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") {
    if (fallback !== undefined) {
      return fallback;
    }
    if (required) {
      throw new Error(`Missing required environment variable: ${name}`);
    }
    return undefined;
  }

  const parsed = parse ? parse(raw) : raw;
  if (validate && !validate.fn(parsed)) {
    throw new Error(`Invalid ${name}: ${validate.reason}`);
  }
  return parsed;
}

function loadConfig() {
  return {
    rpcUrl: parseEnv("SOROBAN_RPC_URL", {
      fallback: "https://soroban-testnet.stellar.org",
    }),
    contractId: parseEnv("KEEPER_CONTRACT_ID", {
      fallback: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM",
    }),
    secretKey: parseEnv("KEEPER_SECRET_KEY", {
      fallback: "SDJNANL6OQC7D7U4HCNQFR3W4Z67G4D6F4O2256W5Z7U3C46C4T33K3Y",
    }),
    networkPassphrase: parseEnv("NETWORK_PASSPHRASE", {
      fallback: "Test SDF Network ; September 2015",
    }),
    maxRoundSpendStroops: parseEnv("MAX_ROUND_SPEND_STROOPS", {
      parse: BigInt,
      validate: { fn: (v) => v > 0n, reason: "must be positive" },
      fallback: 5_000_000n,
    }),
    maxConcurrency: parseEnv("MAX_CONCURRENCY", {
      parse: Number,
      validate: { fn: (v) => Number.isInteger(v) && v > 0, reason: "must be positive integer" },
      fallback: 4,
    }),
    minProfitMarginStroops: parseEnv("MIN_PROFIT_MARGIN_STROOPS", {
      parse: BigInt,
      validate: { fn: (v) => v >= 0n, reason: "must be non-negative" },
      fallback: 0n,
    }),
    pollIntervalMs: parseEnv("POLL_INTERVAL_MS", {
      parse: Number,
      validate: { fn: (v) => Number.isInteger(v) && v >= 100, reason: "must be >= 100ms" },
      fallback: 5000,
    }),
    simulateExecution: parseEnv("SIMULATE_EXECUTION", {
      parse: (v) => String(v).toLowerCase() === "true",
      fallback: false,
    }),
  };
}

module.exports = {
  loadConfig,
};
