import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { CONTRACT_ID, KEEPER, SECRET, contractError, rawTask, runCli, tempDir } from "./harness.js";

const ENV = { SKN_SECRET_KEY: SECRET };
const ON = ["--contract-id", CONTRACT_ID];

/** Parses stdout as exactly one JSON object, failing the test otherwise. */
function parseSingleObject(stdout: string): Record<string, unknown> {
  expect(stdout.endsWith("\n")).toBe(true);
  expect(stdout.trimEnd().split("\n")).toHaveLength(1);
  return JSON.parse(stdout) as Record<string, unknown>;
}

describe("skn --json", () => {
  it("prints the claim result as one JSON object, with u64 fields as decimal strings", async () => {
    const { code, stdout, stderr } = await runCli(["task", "claim", "7", "--json", ...ON], {
      env: ENV,
      rpc: { results: { get_task: rawTask({ claim_ledger: 990, lock_ledgers: 100 }) }, latestLedger: 1_000 },
    });

    expect(code).toBe(0);
    expect(stderr).toBe("");
    expect(parseSingleObject(stdout)).toEqual({
      ok: true,
      taskId: "7",
      keeper: KEEPER,
      status: "claimed",
      lockExpiresAtLedger: 1090,
      currentLedger: 1000,
      ledgersRemaining: 90,
    });
  });

  it("reports a null lock expiry when reading it back fails, and still succeeds", async () => {
    const { code, stdout, stderr } = await runCli(["task", "claim", "7", "--json", ...ON], {
      env: ENV,
      rpc: { simulationErrors: { get_task: "upstream connect error" } },
    });

    expect(code).toBe(0);
    expect(stderr).toContain("warning: could not read the lock expiry");
    expect(parseSingleObject(stdout)).toMatchObject({ ok: true, status: "claimed", lockExpiresAtLedger: null });
  });

  it("keeps bigint amounts exact past the 2^53 limit of JavaScript numbers", async () => {
    const reward = 9_007_199_254_740_993n; // 2^53 + 1: a JavaScript number would round this
    const { code, stdout } = await runCli(["task", "execute", "7", "--proof", "0xAB", "--json", ...ON], {
      env: ENV,
      rpc: { results: { get_task: rawTask({ reward }), get_fee_bps: 0, dispute_window: 0 } },
    });

    expect(code).toBe(0);
    const body = parseSingleObject(stdout);
    expect(body).toMatchObject({
      ok: true,
      status: "executed",
      taskReward: "9007199254740993",
      rewardCredited: "9007199254740993",
      protocolFee: "0",
      feeBps: 0,
      disputeWindowLedgers: 0,
    });
  });

  it("reports a null dispute window when the contract does not expose one", async () => {
    const { stdout } = await runCli(["task", "execute", "7", "--proof", "0xAB", "--json", ...ON], {
      env: ENV,
      rpc: {
        results: { get_task: rawTask({ reward: 1_000n }), get_fee_bps: 0 },
        simulationErrors: { dispute_window: "unknown function" },
      },
    });

    expect(parseSingleObject(stdout)).toMatchObject({ ok: true, disputeWindowLedgers: null });
  });

  it("prints the effective config as JSON", async () => {
    const { code, stdout } = await runCli(["config", "show", "--json"], { env: {} });

    expect(code).toBe(0);
    expect(parseSingleObject(stdout)).toMatchObject({
      ok: true,
      profile: "testnet",
      contractId: null,
      isMainnet: false,
    });
  });

  it("reports the written config path and profiles from config init", async () => {
    const path = join(await tempDir(), "config.json");
    const { code, stdout } = await runCli(["config", "init", "--config", path, "--json"]);

    expect(code).toBe(0);
    expect(parseSingleObject(stdout)).toEqual({
      ok: true,
      path,
      profiles: ["testnet", "futurenet", "mainnet"],
      defaultProfile: "testnet",
    });
  });

  it("writes a usage error as a JSON object on stdout, with exit code 2", async () => {
    const { code, stdout, stderr } = await runCli(["task", "claim", "7", "--json"], { env: ENV });

    expect(code).toBe(2);
    expect(stderr).toBe("");
    expect(parseSingleObject(stdout)).toEqual({
      ok: false,
      error: {
        kind: "usage",
        exitCode: 2,
        message: expect.stringContaining("contract ID"),
      },
    });
  });

  it("writes a contract rejection with exit code 3 and kind contract", async () => {
    const { code, stdout } = await runCli(["task", "claim", "404", "--json", ...ON], {
      env: ENV,
      rpc: { simulationErrors: { claim_task: contractError(4) } },
    });

    expect(code).toBe(3);
    expect(parseSingleObject(stdout)).toMatchObject({ ok: false, error: { kind: "contract", exitCode: 3 } });
  });

  it("writes an RPC failure with exit code 4 and kind rpc", async () => {
    const { code, stdout } = await runCli(["task", "claim", "7", "--json", ...ON], {
      env: ENV,
      rpc: { simulationErrors: { claim_task: "upstream connect error" } },
    });

    expect(code).toBe(4);
    expect(parseSingleObject(stdout)).toMatchObject({ ok: false, error: { kind: "rpc", exitCode: 4 } });
  });

  it("never prints a secret in JSON output, including on errors", async () => {
    const { output } = await runCli(["task", "claim", "7", "--json"], { env: ENV });

    expect(output).not.toContain(SECRET);
  });

  it("leaves text output unchanged without the flag", async () => {
    const { stdout } = await runCli(["config", "show"], { env: {} });

    expect(stdout).toContain("Profile:");
    expect(() => JSON.parse(stdout)).toThrow();
  });
});
