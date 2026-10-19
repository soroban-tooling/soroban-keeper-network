import { readFile } from "node:fs/promises";

import { SUPPORTED_CONTRACT_VERSIONS } from "@soroban-keeper-network/sdk";
import type { Command } from "commander";
import { describe, expect, it } from "vitest";

import { buildProgram } from "../src/cli.js";
import { createContext, SecretRedactor } from "../src/context.js";
import { CLI_VERSION } from "../src/version.js";
import { CONTRACT_ID, KEEPER, SECRET, rawTask, runCli } from "./harness.js";

/** Every command path in the tree, e.g. ["task", "claim"]. */
function commandPaths(): string[][] {
  const program = buildProgram(
    createContext(
      { stdout: () => {}, stderr: () => {}, env: {}, cwd: ".", homedir: ".", platform: "linux" },
      new SecretRedactor(),
    ),
  );
  const paths: string[][] = [];
  const walk = (command: Command, prefix: string[]): void => {
    for (const child of command.commands) {
      const path = [...prefix, child.name()];
      paths.push(path);
      walk(child, path);
    }
  };
  walk(program, []);
  return paths;
}

describe("skn --help", () => {
  it("lists every command group from the CLI scope", async () => {
    const { code, stdout } = await runCli(["--help"]);

    expect(code).toBe(0);
    for (const group of ["task", "keeper", "admin", "batch", "deploy", "events", "config"]) {
      expect(stdout).toMatch(new RegExp(`^\\s+${group}\\b`, "m"));
    }
  });

  it("is available on every command", async () => {
    for (const path of commandPaths()) {
      const { code, stdout } = await runCli([...path, "--help"]);
      expect(code, path.join(" ")).toBe(0);
      expect(stdout, path.join(" ")).toContain(`Usage: skn ${path.join(" ")}`);
    }
  });

  it("exits with the usage code when no command is given", async () => {
    const { code, stderr } = await runCli([]);

    expect(code).toBe(2);
    expect(stderr).toContain("Usage: skn");
  });

  it("rejects an unknown command with the usage code", async () => {
    const { code, stderr } = await runCli(["frobnicate"]);

    expect(code).toBe(2);
    expect(stderr).toContain("unknown command");
  });
});

describe("skn --version", () => {
  it("prints the CLI version and the supported contract versions", async () => {
    const { code, stdout } = await runCli(["--version"]);

    expect(code).toBe(0);
    expect(stdout).toContain(`skn ${CLI_VERSION}`);
    const { min, max } = SUPPORTED_CONTRACT_VERSIONS;
    expect(stdout).toContain(`keeper-registry contract versions: ${min}-${max}`);
  });

  it("matches package.json", async () => {
    const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
      version: string;
    };
    expect(CLI_VERSION).toBe(pkg.version);
  });
});

describe("end to end against the fake RPC", () => {
  it("claims a task: one signed transaction submitted, then the task read back", async () => {
    const { code, stdout, stderr, rpc } = await runCli(
      ["task", "claim", "7", "--contract-id", CONTRACT_ID],
      {
        env: { SKN_SECRET_KEY: SECRET },
        rpc: { results: { get_task: rawTask() }, latestLedger: 1_000 },
      },
    );

    expect(stderr).toBe("");
    expect(code).toBe(0);
    expect(rpc.calls.map((call) => call.method)).toEqual(["claim_task", "get_task"]);
    expect(rpc.calls[0]?.args).toEqual([KEEPER, 7n]);
    expect(rpc.submitted).toHaveLength(1);
    expect(stdout).toContain(`Claimed task 7 as ${KEEPER}.`);
  });
});
