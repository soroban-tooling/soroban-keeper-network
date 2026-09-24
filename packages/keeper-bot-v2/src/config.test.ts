/**
 * Test suite for configuration loading and validation.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { loadConfig } from "./config.js";

describe("Config Loading", () => {
  beforeEach(() => {
    // Clear environment before each test
    Object.keys(process.env).forEach((key) => {
      if (key.startsWith("REGISTRY_CONTRACT_ID") || key.startsWith("KEEPER_SECRET_KEY")) {
        delete process.env[key];
      }
    });
  });

  it("should load default values when env vars are not set", async () => {
    process.env.REGISTRY_CONTRACT_ID = "CJEJJGV5DSGH2EHZQRKP4WUNBT4FQKC23FRNVLMVFZM3CZIRNP4K5B7";
    process.env.KEEPER_SECRET_KEY = "SBUGWJMUXZPYXXYUPSUJJCXKJ4XPVPMRSEFZQNLDJ5HMLMQP6V3GRSGF";

    const config = await loadConfig();

    expect(config.network).toBe("testnet");
    expect(config.maxRetries).toBe(3);
    expect(config.retryBaseMs).toBe(500);
    expect(config.pollIntervalMs).toBe(10000);
    expect(config.consecutiveExhaustedRetriesForDegradedMode).toBe(3);
    expect(config.degradedModePollingIntervalMs).toBe(60000);
  });

  it("should load custom values when env vars are set", async () => {
    process.env.NETWORK = "mainnet";
    process.env.REGISTRY_CONTRACT_ID = "CJEJJGV5DSGH2EHZQRKP4WUNBT4FQKC23FRNVLMVFZM3CZIRNP4K5B7";
    process.env.KEEPER_SECRET_KEY = "SBUGWJMUXZPYXXYUPSUJJCXKJ4XPVPMRSEFZQNLDJ5HMLMQP6V3GRSGF";
    process.env.MAX_RETRIES = "5";
    process.env.RETRY_BASE_MS = "1000";
    process.env.POLL_INTERVAL_MS = "5000";
    process.env.CONSECUTIVE_EXHAUSTED_RETRIES_FOR_DEGRADED_MODE = "5";
    process.env.DEGRADED_MODE_POLLING_INTERVAL_MS = "30000";

    const config = await loadConfig();

    expect(config.network).toBe("mainnet");
    expect(config.maxRetries).toBe(5);
    expect(config.retryBaseMs).toBe(1000);
    expect(config.pollIntervalMs).toBe(5000);
    expect(config.consecutiveExhaustedRetriesForDegradedMode).toBe(5);
    expect(config.degradedModePollingIntervalMs).toBe(30000);
  });

  it("should validate config values and fail on invalid inputs", async () => {
    process.env.REGISTRY_CONTRACT_ID = "INVALID";
    process.env.KEEPER_SECRET_KEY = "SBUGWJMUXZPYXXYUPSUJJCXKJ4XPVPMRSEFZQNLDJ5HMLMQP6V3GRSGF";

    // Mock process.exit to catch the failure
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);

    await loadConfig();

    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });
});
