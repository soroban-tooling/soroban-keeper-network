import { describe, it } from "node:test";
import assert from "node:assert";
import { validateConfig, ConfigValidationError } from "../src/config.js";

// Valid base configuration for tests
const VALID_BASE_ENV: Record<string, string> = {
  NETWORK: "testnet",
  REGISTRY_CONTRACT_ID: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM",
  KEEPER_SECRET_KEY: "SBGWKM3CD4IL47QN6X54N6Y33T3JDNVI6AIJ6CD5IM47HG3IG4O36XCU",
  POLL_INTERVAL_MS: "10000",
  MAX_TASKS_PER_ROUND: "5",
  MAX_CONCURRENT_TASKS: "1",
  MIN_PROFIT_MARGIN_STROOPS: "0",
  FEE_CEILING_STROOPS: "1000000",
  WITHDRAW_THRESHOLD: "10000000",
  MAX_RETRIES: "3",
  RETRY_BASE_MS: "500",
  EXPIRE_STALE_TASKS: "true",
  SIMULATE_EXECUTION: "false",
  SECRET_BACKEND: "env",
  METRICS_ENABLED: "true",
  METRICS_PORT: "9090",
};

describe("Keeper Bot v2 Configuration Validation", () => {
  describe("Valid Configurations", () => {
    it("accepts a minimal valid configuration", () => {
      const config = validateConfig({
        REGISTRY_CONTRACT_ID: VALID_BASE_ENV.REGISTRY_CONTRACT_ID,
        KEEPER_SECRET_KEY: VALID_BASE_ENV.KEEPER_SECRET_KEY,
      });

      assert.strictEqual(config.network, "testnet");
      assert.strictEqual(config.maxConcurrentTasks, 1);
      assert.strictEqual(config.maxTasksPerRound, 5);
      assert.strictEqual(config.signingKeys.length, 1);
      assert.strictEqual(config.minProfitMarginStroops, 0n);
      assert.strictEqual(config.feeCeilingStroops, 1000000n);
    });

    it("accepts a multi-account signing pool configuration", () => {
      const key1 = "SBGWKM3CD4IL47QN6X54N6Y33T3JDNVI6AIJ6CD5IM47HG3IG4O36XCU";
      const config = validateConfig({
        ...VALID_BASE_ENV,
        SIGNING_KEY_POOL: `${key1},${key1}`,
        MAX_CONCURRENT_TASKS: "2",
        MAX_TASKS_PER_ROUND: "10",
      });

      assert.strictEqual(config.signingKeys.length, 2);
      assert.strictEqual(config.maxConcurrentTasks, 2);
    });
  });

  describe("Per-Field Fail-Fast Validation Discipline", () => {
    it("rejects missing REGISTRY_CONTRACT_ID", () => {
      const env = { ...VALID_BASE_ENV };
      delete env.REGISTRY_CONTRACT_ID;

      assert.throws(
        () => validateConfig(env),
        (err: Error) => {
          assert.ok(err instanceof ConfigValidationError);
          assert.strictEqual(err.field, "REGISTRY_CONTRACT_ID");
          assert.match(err.message, /REGISTRY_CONTRACT_ID.*must be set/);
          return true;
        }
      );
    });

    it("rejects invalid REGISTRY_CONTRACT_ID format", () => {
      const env = { ...VALID_BASE_ENV, REGISTRY_CONTRACT_ID: "invalid-id" };

      assert.throws(
        () => validateConfig(env),
        (err: Error) => {
          assert.ok(err instanceof ConfigValidationError);
          assert.strictEqual(err.field, "REGISTRY_CONTRACT_ID");
          assert.match(err.message, /must be a valid contract ID/);
          return true;
        }
      );
    });

    it("rejects invalid KEEPER_SECRET_KEY without leaking secret value", () => {
      const env = { ...VALID_BASE_ENV, KEEPER_SECRET_KEY: "SNOTVALIDSECRETVALUE12345" };

      assert.throws(
        () => validateConfig(env),
        (err: Error) => {
          assert.ok(err instanceof ConfigValidationError);
          assert.match(err.message, /must be a valid secret seed/);
          assert.ok(!err.message.includes("SNOTVALIDSECRETVALUE12345"), "Secret must never leak in error output");
          return true;
        }
      );
    });

    it("rejects unsupported NETWORK", () => {
      const env = { ...VALID_BASE_ENV, NETWORK: "polygon" };

      assert.throws(
        () => validateConfig(env),
        (err: Error) => {
          assert.ok(err instanceof ConfigValidationError);
          assert.strictEqual(err.field, "NETWORK");
          assert.match(err.message, /must be one of: testnet, futurenet, mainnet/);
          return true;
        }
      );
    });

    it("rejects negative or out-of-range numeric fields", () => {
      assert.throws(
        () => validateConfig({ ...VALID_BASE_ENV, POLL_INTERVAL_MS: "500" }),
        /POLL_INTERVAL_MS.*must be >= 1000/
      );
      assert.throws(
        () => validateConfig({ ...VALID_BASE_ENV, MAX_TASKS_PER_ROUND: "0" }),
        /MAX_TASKS_PER_ROUND.*must be >= 1/
      );
      assert.throws(
        () => validateConfig({ ...VALID_BASE_ENV, RETRY_BASE_MS: "0" }),
        /RETRY_BASE_MS.*must be > 0/
      );
      assert.throws(
        () => validateConfig({ ...VALID_BASE_ENV, METRICS_PORT: "70000" }),
        /METRICS_PORT.*must be between 1 and 65535/
      );
    });
  });

  describe("Cross-Field Consistency Checks (Startup Inconsistencies)", () => {
    it("catches concurrency limit exceeding account pool size", () => {
      // 1 single key configured, but MAX_CONCURRENT_TASKS=4
      const env = {
        ...VALID_BASE_ENV,
        MAX_CONCURRENT_TASKS: "4",
        MAX_TASKS_PER_ROUND: "10",
      };

      assert.throws(
        () => validateConfig(env),
        (err: Error) => {
          assert.ok(err instanceof ConfigValidationError);
          assert.strictEqual(err.field, "MAX_CONCURRENT_TASKS");
          assert.match(
            err.message,
            /Cross-field validation failed: MAX_CONCURRENT_TASKS \(4\) cannot exceed the number of signing accounts in the pool \(1\)/
          );
          return true;
        }
      );
    });

    it("catches profitability margin exceeding fee ceiling", () => {
      // MIN_PROFIT_MARGIN_STROOPS=2,000,000 > FEE_CEILING_STROOPS=500,000
      const env = {
        ...VALID_BASE_ENV,
        MIN_PROFIT_MARGIN_STROOPS: "2000000",
        FEE_CEILING_STROOPS: "500000",
      };

      assert.throws(
        () => validateConfig(env),
        (err: Error) => {
          assert.ok(err instanceof ConfigValidationError);
          assert.strictEqual(err.field, "MIN_PROFIT_MARGIN_STROOPS");
          assert.match(
            err.message,
            /Cross-field validation failed: MIN_PROFIT_MARGIN_STROOPS \(2000000\) exceeds FEE_CEILING_STROOPS \(500000\)/
          );
          return true;
        }
      );
    });

    it("catches concurrency limit exceeding max tasks per round", () => {
      // MAX_CONCURRENT_TASKS=5, MAX_TASKS_PER_ROUND=2
      const env = {
        ...VALID_BASE_ENV,
        MAX_CONCURRENT_TASKS: "5",
        MAX_TASKS_PER_ROUND: "2",
        SIGNING_KEY_POOL: new Array(5).fill(VALID_BASE_ENV.KEEPER_SECRET_KEY).join(","),
      };

      assert.throws(
        () => validateConfig(env),
        (err: Error) => {
          assert.ok(err instanceof ConfigValidationError);
          assert.strictEqual(err.field, "MAX_CONCURRENT_TASKS");
          assert.match(
            err.message,
            /Cross-field validation failed: MAX_CONCURRENT_TASKS \(5\) cannot exceed MAX_TASKS_PER_ROUND \(2\)/
          );
          return true;
        }
      );
    });

    it("catches missing secret manager configuration when non-env backend selected", () => {
      const vaultEnv = {
        ...VALID_BASE_ENV,
        SECRET_BACKEND: "vault",
        VAULT_ADDR: "",
      };
      assert.throws(
        () => validateConfig(vaultEnv),
        (err: Error) => {
          assert.ok(err instanceof ConfigValidationError);
          assert.strictEqual(err.field, "VAULT_ADDR");
          assert.match(err.message, /SECRET_BACKEND is set to "vault", but VAULT_ADDR is missing/);
          return true;
        }
      );

      const awsEnv = {
        ...VALID_BASE_ENV,
        SECRET_BACKEND: "aws_secrets_manager",
        AWS_SECRET_NAME: "",
      };
      assert.throws(
        () => validateConfig(awsEnv),
        (err: Error) => {
          assert.ok(err instanceof ConfigValidationError);
          assert.strictEqual(err.field, "AWS_SECRET_NAME");
          assert.match(err.message, /SECRET_BACKEND is set to "aws_secrets_manager", but AWS_SECRET_NAME is missing/);
          return true;
        }
      );
    });

    it("catches retry backoff exceeding 10x poll interval", () => {
      // RETRY_BASE_MS=5000, MAX_RETRIES=6 => 5000 * 64 = 320,000ms > 10 * 10,000ms = 100,000ms
      const env = {
        ...VALID_BASE_ENV,
        RETRY_BASE_MS: "5000",
        MAX_RETRIES: "6",
        POLL_INTERVAL_MS: "10000",
      };

      assert.throws(
        () => validateConfig(env),
        (err: Error) => {
          assert.ok(err instanceof ConfigValidationError);
          assert.strictEqual(err.field, "RETRY_BASE_MS");
          assert.match(
            err.message,
            /Cross-field validation failed: Maximum retry backoff duration/
          );
          return true;
        }
      );
    });
  });
});
