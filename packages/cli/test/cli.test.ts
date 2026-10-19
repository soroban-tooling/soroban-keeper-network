import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { StrKey } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { run } from "../src/cli.js";
import { EXIT } from "../src/exitCodes.js";
import { CLI_VERSION } from "../src/version.js";
import { FakeRpc } from "./support/fakeRpc.js";

const CONTRACT_ID = StrKey.encodeContract(Buffer.alloc(32, 7));

const packageJson = JSON.parse(
  readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
) as { version: string };

describe("skn --help and --version", () => {
  it("lists every command group from the design document", async () => {
    const result = await run(["--help"]);

    expect(result.exitCode).toBe(EXIT.ok);
    for (const group of [
      "config",
      "task",
      "keeper",
      "admin",
      "batch",
      "deploy",
      "events",
      "inspect",
    ]) {
      expect(result.stdout).toMatch(new RegExp(`^\\s+${group}\\s`, "m"));
    }
  });

  it("prints the CLI version and the contract versions it supports", async () => {
    const result = await run(["--version"]);

    expect(result.exitCode).toBe(EXIT.ok);
    expect(result.stdout).toContain(`skn ${CLI_VERSION}`);
    expect(result.stdout).toContain("supported contract VERSION: 1 to 3");
  });

  it("keeps the CLI_VERSION constant in step with package.json", () => {
    expect(CLI_VERSION).toBe(packageJson.version);
  });
});

describe("skn inspect version, end to end against the fake RPC", () => {
  it("reports the deployed contract VERSION", async () => {
    const server = new FakeRpc({ results: { version: 3 } });

    const result = await run(
      ["inspect", "version", "--contract-id", CONTRACT_ID],
      { server },
    );

    expect(result.exitCode).toBe(EXIT.ok);
    expect(result.stdout).toContain("VERSION 3");
    expect(result.stdout).toContain("supported by this CLI");
    expect(result.stderr).toBe("");
  });

  it("prints machine-readable JSON with --json", async () => {
    const server = new FakeRpc({ results: { version: 3 } });

    const result = await run(
      ["inspect", "version", "--contract-id", CONTRACT_ID, "--json"],
      { server },
    );

    expect(result.exitCode).toBe(EXIT.ok);
    expect(JSON.parse(result.stdout)).toEqual({
      contractId: CONTRACT_ID,
      network: "testnet",
      contractVersion: 3,
      compatible: true,
      status: "compatible",
      supportedVersions: { min: 1, max: 3 },
    });
  });

  it("exits 0 but warns on stderr when the contract is newer than this CLI supports", async () => {
    const server = new FakeRpc({ results: { version: 4 } });

    const result = await run(
      ["inspect", "version", "--contract-id", CONTRACT_ID, "--json"],
      { server },
    );

    expect(result.exitCode).toBe(EXIT.ok);
    expect(JSON.parse(result.stdout)).toMatchObject({
      contractVersion: 4,
      compatible: false,
      status: "contract-newer",
    });
    expect(result.stderr).toContain("skn: warning: The deployed keeper-registry reports VERSION 4");
  });

  it("exits with the contract error code when the contract rejects the call", async () => {
    const server = new FakeRpc({
      simulationErrors: { version: "Error(Contract, #12)" },
    });

    const result = await run(
      ["inspect", "version", "--contract-id", CONTRACT_ID, "--json"],
      { server },
    );

    expect(result.exitCode).toBe(EXIT.contract);
    expect(JSON.parse(result.stdout).error.code).toBe("CONTRACT_ERROR");
  });
});

describe("usage errors", () => {
  it("exits 2 for an unknown command", async () => {
    const result = await run(["frobnicate"]);

    expect(result.exitCode).toBe(EXIT.usage);
    expect(result.stderr).toContain("unknown command 'frobnicate'");
  });

  it("exits 2 for a command whose group exists but is not implemented yet", async () => {
    const result = await run(["task", "register"]);

    expect(result.exitCode).toBe(EXIT.usage);
    expect(result.stderr).toContain("'skn task register' is not implemented yet");
  });

  it("exits 2 when --contract-id is missing", async () => {
    const result = await run(["inspect", "version"]);

    expect(result.exitCode).toBe(EXIT.usage);
    expect(result.stderr).toContain("--contract-id is required");
  });

  it("exits 2 for an unknown network name", async () => {
    const result = await run([
      "inspect",
      "version",
      "--contract-id",
      CONTRACT_ID,
      "--network",
      "moonnet",
    ]);

    expect(result.exitCode).toBe(EXIT.usage);
    expect(result.stderr).toContain("unknown network 'moonnet'");
  });

  it("exits 2 for an unrecognised flag and reports it as JSON with --json", async () => {
    const result = await run([
      "inspect",
      "version",
      "--contract-id",
      CONTRACT_ID,
      "--bogus",
      "--json",
    ]);

    expect(result.exitCode).toBe(EXIT.usage);
    expect(JSON.parse(result.stdout).error.code).toBe("USAGE_ERROR");
  });
});
