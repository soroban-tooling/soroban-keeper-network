import { describe, expect, it } from "vitest";

import { CliError, toCliError } from "../src/errors.js";
import { jsonLines, OWNER, OWNER_SECRET, registerRpc, runCli } from "./support/harness.js";

const REGISTER = [
  "task", "register", "--type", "custom", "--reward", "1000", "--deadline", "+1h",
  "--ttl-ledgers", "20000", "--lock-ledgers", "120", "--yes",
];

describe("key handling", () => {
  it("asks for a key, by name, when a signing command has none", async () => {
    const result = await runCli(REGISTER, { env: { SKN_SECRET_KEY: undefined } });

    expect(result.code).toBe(2);
    expect(result.stderr).toContain("SKN_SECRET_KEY");
    expect(result.stderr).toContain("--key-file");
    expect(result.rpc.calls).toHaveLength(0);
  });

  it("rejects a malformed key without echoing it", async () => {
    const bogus = "SNOTAREALKEYNOTAREALKEYNOTAREALKEYNOTAREALKEYNOTAREALKEY12";
    const result = await runCli(REGISTER, { env: { SKN_SECRET_KEY: bogus } });

    expect(result.code).toBe(2);
    expect(result.stderr).not.toContain(bogus);
    expect(result.stdout).not.toContain(bogus);
  });

  it("reads the key from --key-file, using the first non-empty line", async () => {
    const result = await runCli([...REGISTER, "--key-file", "owner.key", "--json"], {
      env: { SKN_SECRET_KEY: undefined },
      files: { "owner.key": `\n  ${OWNER_SECRET}  \n` },
      rpc: registerRpc(7n),
    });

    expect(result.code).toBe(0);
    expect(jsonLines(result.stdout)[0]?.owner).toBe(OWNER);
  });

  it("prefers --key-file over SKN_SECRET_KEY", async () => {
    const result = await runCli([...REGISTER, "--key-file", "missing.key"], {
      rpc: registerRpc(7n),
    });

    // The file is consulted (and does not exist) even though the environment holds a valid key.
    expect(result.code).not.toBe(0);
  });

  it("never prints the secret, on success or on failure", async () => {
    const ok = await runCli(REGISTER, { rpc: registerRpc(7n) });
    const failed = await runCli(REGISTER, {
      rpc: registerRpc(7n, {
        simulationErrors: { register_task: "HostError: Error(Contract, #8)" },
      }),
    });

    for (const result of [ok, failed]) {
      expect(result.stdout).not.toContain(OWNER_SECRET);
      expect(result.stderr).not.toContain(OWNER_SECRET);
    }
  });

  it("scrubs a secret that an upstream message echoed", () => {
    const error = toCliError(new Error(`rejected key ${OWNER_SECRET} for account`), [OWNER_SECRET]);

    expect(error).toBeInstanceOf(CliError);
    expect(error.message).not.toContain(OWNER_SECRET);
    expect(error.message).toContain("[redacted]");
  });
});
