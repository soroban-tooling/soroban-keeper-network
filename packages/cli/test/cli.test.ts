import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { SUPPORTED_CONTRACT_VERSIONS } from "@soroban-keeper-network/sdk";

import { CLI_VERSION } from "../src/index.js";
import { runCli } from "./support/harness.js";

describe("skn --help", () => {
  it("lists the command groups", async () => {
    const result = await runCli(["--help"]);

    expect(result.code).toBe(0);
    for (const group of ["task", "admin", "events"]) {
      expect(result.stdout).toMatch(new RegExp(`^\\s+${group}\\b`, "m"));
    }
    expect(result.stdout).toContain("--json");
    expect(result.stdout).toContain("Exit codes:");
  });

  it.each([
    [["task", "--help"]],
    [["task", "register", "--help"]],
    [["admin", "--help"]],
    [["admin", "show", "--help"]],
    [["admin", "pause", "--help"]],
    [["admin", "unpause", "--help"]],
    [["admin", "set-fee-bps", "--help"]],
    [["admin", "set-min-reward", "--help"]],
    [["events", "--help"]],
    [["events", "watch", "--help"]],
  ])("has help for %j", async (argv) => {
    const result = await runCli(argv);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Usage: skn");
  });
});

describe("skn --version", () => {
  it("prints the CLI version and the supported contract versions", async () => {
    const result = await runCli(["--version"]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`skn ${CLI_VERSION}`);
    expect(result.stdout).toContain(
      `${SUPPORTED_CONTRACT_VERSIONS.min}-${SUPPORTED_CONTRACT_VERSIONS.max}`,
    );
  });

  it("matches package.json, so a release cannot ship a stale version", () => {
    const pkg = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version: string; bin: Record<string, string> };

    expect(CLI_VERSION).toBe(pkg.version);
    expect(pkg.bin.skn).toBe("./dist/bin.js");
  });
});

describe("usage errors", () => {
  it("exits 2 on an unknown command", async () => {
    const result = await runCli(["frobnicate"]);

    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
  });

  it("exits 2 when no registry contract is configured", async () => {
    const result = await runCli(["admin", "show"], { env: { SKN_CONTRACT_ID: undefined } });

    expect(result.code).toBe(2);
    expect(result.stderr).toContain("SKN_CONTRACT_ID");
  });

  it("exits 2 on an unknown network", async () => {
    const result = await runCli(["--network", "moonbase", "admin", "show"]);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain("Unknown network");
  });

  it("lets flags override the environment", async () => {
    const result = await runCli(["admin", "show", "--contract-id", "not-a-contract"], {
      env: { SKN_CONTRACT_ID: undefined },
    });

    // The flag was used (so no "no contract" usage error); the SDK then rejects the malformed id.
    expect(result.stderr).not.toContain("SKN_CONTRACT_ID");
    expect(result.code).not.toBe(0);
  });
});
