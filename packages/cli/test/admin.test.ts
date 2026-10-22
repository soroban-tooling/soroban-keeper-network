import { describe, expect, it } from "vitest";

import {
  ADMIN,
  ADMIN_SECRET,
  CONTRACT_ID,
  FakeRpc,
  jsonLines,
  runCli,
} from "./support/harness.js";

/** A registry that has an admin; every admin write probes for one first. */
function adminRpc(extra: ConstructorParameters<typeof FakeRpc>[0] = {}): FakeRpc {
  const { results, ...rest } = extra;
  return new FakeRpc({ results: { admin: ADMIN, ...results }, ...rest });
}

const AS_ADMIN = { env: { SKN_SECRET_KEY: ADMIN_SECRET } };

describe("skn admin: writes", () => {
  it.each([
    [["admin", "pause"], "pause", [ADMIN], "Registry paused"],
    [["admin", "unpause"], "unpause", [ADMIN], "Registry unpaused"],
    [["admin", "set-fee-bps", "250"], "set_fee_bps", [ADMIN, 250], "Fee set to 250 bps"],
    [["admin", "set-fee-bps", "10000"], "set_fee_bps", [ADMIN, 10_000], "Fee set to 10000 bps"],
    [["admin", "set-min-reward", "5000"], "set_min_reward", [ADMIN, 5000n], "Minimum reward set to 5000"],
  ])("%j submits %s", async (argv, method, args, message) => {
    const rpc = adminRpc();
    const result = await runCli([...argv, "--yes"], { ...AS_ADMIN, rpc });

    expect(result.code).toBe(0);
    expect(result.stdout).toBe(`${message}\n`);
    // The initialization probe, the fee-pricing simulation, then the real call.
    expect(rpc.calls.map((c) => c.method)).toEqual(["admin", method, method]);
    expect((rpc.calls[2] as NonNullable<(typeof rpc.calls)[number]>).args).toEqual(args);
    expect(rpc.submitted).toHaveLength(1);
    expect(result.stderr).toMatch(/Estimated fee for \w+: \d+ stroops/);
  });

  it("asks for confirmation unless --yes is given", async () => {
    const rpc = adminRpc();
    const refused = await runCli(["admin", "pause"], { ...AS_ADMIN, rpc });
    expect(refused.code).toBe(2);
    expect(rpc.submitted).toHaveLength(0);

    const declined = await runCli(["admin", "pause"], { ...AS_ADMIN, rpc, isTTY: true, answer: false });
    expect(declined.code).toBe(1);
    expect(rpc.submitted).toHaveLength(0);

    const approved = await runCli(["admin", "pause"], { ...AS_ADMIN, rpc, isTTY: true, answer: true });
    expect(approved.code).toBe(0);
    expect(approved.prompts).toEqual(["Submit pause to testnet?"]);
    expect(rpc.submitted).toHaveLength(1);
  });

  it("needs a key", async () => {
    const result = await runCli(["admin", "pause", "--yes"], {
      env: { SKN_SECRET_KEY: undefined },
      rpc: adminRpc(),
    });

    expect(result.code).toBe(2);
    expect(result.stderr).toContain("SKN_SECRET_KEY");
  });
});

describe("skn admin: contract errors", () => {
  it("reports Unauthorized when the key is not the admin", async () => {
    const rpc = adminRpc({ simulationErrors: { pause: "host invocation failed: Error(Contract, #2)" } });
    const result = await runCli(["admin", "pause", "--yes"], { ...AS_ADMIN, rpc });

    expect(result.code).toBe(3);
    expect(result.stderr).toContain("error[Unauthorized]");
    expect(rpc.submitted).toHaveLength(0);
  });

  it("reports NotInitialized for a registry with no admin", async () => {
    const rpc = new FakeRpc({ results: { admin: undefined } });
    const result = await runCli(["admin", "pause", "--yes"], { ...AS_ADMIN, rpc });

    expect(result.code).toBe(3);
    expect(result.stderr).toContain("error[NotInitialized]");
    expect(rpc.submitted).toHaveLength(0);
  });

  it("rejects an out-of-range fee locally, without an RPC call", async () => {
    const rpc = adminRpc();
    const result = await runCli(["admin", "set-fee-bps", "10001", "--yes"], { ...AS_ADMIN, rpc });

    expect(result.code).toBe(3);
    expect(result.stderr).toContain("error[InvalidFeeBps]");
    expect(rpc.calls).toHaveLength(0);
  });

  it("reports a transaction that fails on-chain", async () => {
    const rpc = adminRpc({ onChainFailures: { unpause: 3 } });
    const result = await runCli(["admin", "unpause", "--yes"], { ...AS_ADMIN, rpc });

    expect(result.code).toBe(3);
    expect(result.stderr).toContain("error[ContractPaused]");
  });

  it.each([
    [["admin", "set-fee-bps", "lots"], "<bps>"],
    [["admin", "set-fee-bps", "1e3"], "<bps>"],
    [["admin", "set-min-reward", "1.5"], "<amount>"],
    [["admin", "set-min-reward"], "missing required argument"],
  ])("rejects bad arguments: %j", async (argv, message) => {
    const result = await runCli([...argv, "--yes"], { ...AS_ADMIN, rpc: adminRpc() });

    expect(result.code).toBe(2);
    expect(result.stderr).toContain(message);
  });
});

describe("skn admin show", () => {
  const registry = () =>
    adminRpc({
      results: {
        is_paused: false,
        get_fee_bps: 300,
        min_reward: 1000,
        reward_token_address: CONTRACT_ID,
      },
    });

  it("prints the registry's configuration without needing a key", async () => {
    const result = await runCli(["admin", "show"], {
      env: { SKN_SECRET_KEY: undefined },
      rpc: registry(),
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`admin:        ${ADMIN}`);
    expect(result.stdout).toContain("paused:       false");
    expect(result.stdout).toContain("fee:          300 bps");
    expect(result.stdout).toContain("min reward:   1000");
    expect(result.stdout).toContain(`reward token: ${CONTRACT_ID}`);
  });

  it("prints JSON with --json", async () => {
    const result = await runCli(["admin", "show", "--json"], { rpc: registry() });

    expect(result.code).toBe(0);
    const [doc, ...rest] = jsonLines(result.stdout);
    expect(rest).toHaveLength(0);
    expect(doc).toEqual({
      admin: ADMIN,
      paused: false,
      feeBps: 300,
      minReward: "1000",
      rewardToken: CONTRACT_ID,
      network: "testnet",
      contractId: CONTRACT_ID,
    });
  });

  it("submits nothing: it only simulates reads", async () => {
    const rpc = registry();
    await runCli(["admin", "show"], { rpc });

    expect(rpc.submitted).toHaveLength(0);
  });

  it("reports an RPC failure with exit code 4", async () => {
    const rpc = registry();
    rpc.simulateTransaction = async () => {
      throw new Error("connect ECONNREFUSED");
    };
    const result = await runCli(["admin", "show"], { rpc });

    expect(result.code).toBe(4);
    expect(result.stderr).toContain("error[rpc_error]");
  });
});

describe("skn admin: --json", () => {
  it("prints one JSON document for a write", async () => {
    const result = await runCli(["admin", "set-fee-bps", "250", "--yes", "--json"], {
      ...AS_ADMIN,
      rpc: adminRpc(),
    });

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    const [doc, ...rest] = jsonLines(result.stdout);
    expect(rest).toHaveLength(0);
    expect(doc).toMatchObject({
      action: "set-fee-bps",
      feeBps: 250,
      admin: ADMIN,
      network: "testnet",
      contractId: CONTRACT_ID,
    });
    expect(doc?.feeStroops).toMatch(/^\d+$/);
  });

  it("prints a contract error as a JSON object on stderr", async () => {
    const rpc = adminRpc({ simulationErrors: { pause: "Error(Contract, #2)" } });
    const result = await runCli(["admin", "pause", "--yes", "--json"], { ...AS_ADMIN, rpc });

    expect(result.code).toBe(3);
    expect(result.stdout).toBe("");
    expect(jsonLines(result.stderr)[0]).toMatchObject({
      error: { code: "Unauthorized", exitCode: 3 },
    });
  });
});
