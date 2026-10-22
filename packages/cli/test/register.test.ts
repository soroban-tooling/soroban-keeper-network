import { describe, expect, it } from "vitest";

import {
  CONTRACT_ID,
  OWNER,
  jsonLines,
  registerRpc,
  runCli,
} from "./support/harness.js";

const BASE = [
  "task", "register",
  "--type", "liquidation",
  "--reward", "10000000",
  "--deadline", "+2h",
  "--ttl-ledgers", "20000",
  "--lock-ledgers", "120",
];

describe("skn task register: success", () => {
  it("registers the task, prints the new ID and shows the fee on stderr", async () => {
    const rpc = registerRpc(42n);
    const result = await runCli([...BASE, "--yes"], { rpc });

    expect(result.code).toBe(0);
    expect(result.stdout).toBe("Registered task #42\n");
    expect(result.stderr).toMatch(/Estimated fee for register_task: \d+ stroops \(\d+\.\d{7} XLM\)/);

    // One simulation to price it, one inside the real call; only the latter is submitted.
    expect(rpc.calls.map((c) => c.method)).toEqual(["register_task", "register_task"]);
    expect(rpc.submitted).toHaveLength(1);
  });

  it("encodes the contract arguments from the flags", async () => {
    const rpc = registerRpc(1n);
    const before = Date.now();
    await runCli([...BASE, "--calldata", "0xdeadbeef", "--yes"], { rpc });

    const { args } = rpc.calls[1] as NonNullable<(typeof rpc.calls)[number]>;
    expect(args[0]).toBe(OWNER);
    expect(args[1]).toBe(0); // liquidation
    expect(Buffer.from(args[2] as Buffer).toString("hex")).toBe("deadbeef");
    expect(args[3]).toBe(10_000_000n);
    // +2h from "now", to the second.
    const deadline = Number(args[4]) * 1_000;
    expect(deadline).toBeGreaterThanOrEqual(before + 2 * 3_600_000 - 1_000);
    expect(deadline).toBeLessThanOrEqual(Date.now() + 2 * 3_600_000);
    expect(args[5]).toBe(20_000);
    expect(args[6]).toBe(120);
    expect(args[7] ?? null).toBeNull(); // no verifier
  });

  it("passes an optional verifier", async () => {
    const rpc = registerRpc(1n);
    await runCli([...BASE, "--verifier", CONTRACT_ID, "--yes"], { rpc });

    expect((rpc.calls[1] as NonNullable<(typeof rpc.calls)[number]>).args[7]).toBe(CONTRACT_ID);
  });

  it("accepts an ISO deadline and a numeric task type", async () => {
    const rpc = registerRpc(1n);
    const future = new Date(Date.now() + 86_400_000).toISOString();
    const argv = [...BASE];
    argv[argv.indexOf("liquidation")] = "5";
    argv[argv.indexOf("+2h")] = future;
    const result = await runCli([...argv, "--yes"], { rpc });

    expect(result.code).toBe(0);
    expect((rpc.calls[1] as NonNullable<(typeof rpc.calls)[number]>).args[1]).toBe(5);
  });

  it("reads inputs from --file, with flags taking precedence", async () => {
    const rpc = registerRpc(9n);
    const files = {
      "task.json": JSON.stringify({
        type: "oracle-price-push",
        reward: "500",
        deadline: "+1h",
        ttlLedgers: 2000,
        lockLedgers: 20,
        calldata: "ff00",
      }),
    };
    const result = await runCli(
      ["task", "register", "--file", "task.json", "--reward", "900", "--yes"],
      { rpc, files },
    );

    expect(result.code).toBe(0);
    const { args } = rpc.calls[1] as NonNullable<(typeof rpc.calls)[number]>;
    expect(args[1]).toBe(1); // oracle-price-push, from the file
    expect(args[3]).toBe(900n); // --reward beat the file's 500
    expect(args[5]).toBe(2000);
    expect(Buffer.from(args[2] as Buffer).toString("hex")).toBe("ff00");
  });
});

describe("skn task register: confirmation", () => {
  it("refuses to submit without --yes when there is no terminal", async () => {
    const rpc = registerRpc(1n);
    const result = await runCli(BASE, { rpc, isTTY: false });

    expect(result.code).toBe(2);
    expect(result.stderr).toContain("--yes");
    expect(rpc.submitted).toHaveLength(0);
  });

  it("submits when the person says yes at a terminal", async () => {
    const rpc = registerRpc(3n);
    const result = await runCli(BASE, { rpc, isTTY: true, answer: true });

    expect(result.code).toBe(0);
    expect(result.prompts).toEqual(["Submit register_task to testnet?"]);
    expect(rpc.submitted).toHaveLength(1);
  });

  it("submits nothing when the person says no", async () => {
    const rpc = registerRpc(3n);
    const result = await runCli(BASE, { rpc, isTTY: true, answer: false });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Nothing was submitted");
    expect(rpc.submitted).toHaveLength(0);
  });

  it("refuses to prompt under --json, where a prompt would corrupt the output", async () => {
    const rpc = registerRpc(3n);
    const result = await runCli([...BASE, "--json"], { rpc, isTTY: true, answer: true });

    expect(result.code).toBe(2);
    expect(result.prompts).toHaveLength(0);
    expect(rpc.submitted).toHaveLength(0);
  });
});

describe("skn task register: contract errors", () => {
  it("reports the contract's rejection with exit code 3", async () => {
    const rpc = registerRpc(1n, {
      simulationErrors: { register_task: "HostError: Error(Contract, #8)" },
    });
    const result = await runCli([...BASE, "--yes"], { rpc });

    expect(result.code).toBe(3);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("error[InvalidReward]");
    expect(rpc.submitted).toHaveLength(0);
  });

  it("reports a rejection the SDK caught locally, without touching the RPC", async () => {
    const rpc = registerRpc(1n);
    const argv = [...BASE];
    argv[argv.indexOf("120")] = "1"; // below MIN_LOCK_LEDGERS
    const result = await runCli([...argv, "--yes"], { rpc });

    expect(result.code).toBe(3);
    expect(result.stderr).toContain("error[InvalidTaskParams]");
    expect(rpc.calls).toHaveLength(0);
  });

  it("reports a transaction that fails on-chain", async () => {
    const rpc = registerRpc(1n, { onChainFailures: { register_task: 3 } });
    const result = await runCli([...BASE, "--yes"], { rpc });

    expect(result.code).toBe(3);
    expect(result.stderr).toContain("error[ContractPaused]");
  });
});

describe("skn task register: usage errors", () => {
  it("lists every missing input", async () => {
    const result = await runCli(["task", "register", "--yes"]);

    expect(result.code).toBe(2);
    for (const name of ["--type", "--reward", "--deadline", "--ttl-ledgers", "--lock-ledgers"]) {
      expect(result.stderr).toContain(name);
    }
  });

  it.each([
    ["--type", "sorcery", "Unknown task type"],
    ["--reward", "-5", "--reward"],
    ["--reward", "1.5", "--reward"],
    ["--deadline", "next tuesday", "Could not read deadline"],
    ["--deadline", "2030-01-01T00:00:00", "timezone"],
    ["--ttl-ledgers", "many", "--ttl-ledgers"],
    ["--calldata", "xyz", "hex"],
  ])("rejects a bad %s of %j", async (flag, bad, message) => {
    const argv = [...BASE, "--calldata", "00"];
    argv[argv.indexOf(flag) + 1] = bad;
    const result = await runCli([...argv, "--yes"]);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain(message);
  });

  it("rejects a --file that is not a JSON object", async () => {
    const result = await runCli(["task", "register", "--file", "bad.json", "--yes"], {
      files: { "bad.json": "[1, 2]" },
    });

    expect(result.code).toBe(2);
    expect(result.stderr).toContain("JSON object");
  });
});

describe("skn task register: --json", () => {
  it("prints one JSON document with the new task ID on stdout and nothing on stderr", async () => {
    const rpc = registerRpc(42n);
    const result = await runCli([...BASE, "--yes", "--json"], { rpc });

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    const [doc, ...rest] = jsonLines(result.stdout);
    expect(rest).toHaveLength(0);
    expect(doc).toMatchObject({
      taskId: "42",
      owner: OWNER,
      taskType: "Liquidation",
      reward: "10000000",
      network: "testnet",
      contractId: CONTRACT_ID,
    });
    expect(doc?.feeStroops).toMatch(/^\d+$/);
    expect(new Date(String(doc?.deadline)).getTime()).toBeGreaterThan(Date.now());
  });

  it("prints contract errors as a JSON object on stderr", async () => {
    const rpc = registerRpc(1n, {
      simulationErrors: { register_task: "HostError: Error(Contract, #8)" },
    });
    const result = await runCli([...BASE, "--yes", "--json"], { rpc });

    expect(result.code).toBe(3);
    expect(result.stdout).toBe("");
    const [doc] = jsonLines(result.stderr);
    expect(doc).toMatchObject({ error: { code: "InvalidReward", exitCode: 3 } });
  });

  it("prints usage errors as a JSON object too", async () => {
    const result = await runCli(["task", "register", "--json"]);

    expect(result.code).toBe(2);
    const [doc] = jsonLines(result.stderr);
    expect(doc).toMatchObject({ error: { code: "usage", exitCode: 2 } });
  });
});
