import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { MAX_PROOF_LEN } from "@soroban-keeper-network/sdk";
import { describe, expect, it } from "vitest";

import { CONTRACT_ID, KEEPER, SECRET, contractError, rawTask, runCli, tempDir } from "./harness.js";

const ENV = { SKN_SECRET_KEY: SECRET };
const ON = ["--contract-id", CONTRACT_ID];

describe("skn task claim", () => {
  it("reports the lock expiry ledger and an estimate of the time left", async () => {
    const { code, stdout } = await runCli(["task", "claim", "7", ...ON], {
      env: ENV,
      rpc: { results: { get_task: rawTask({ claim_ledger: 990, lock_ledgers: 100 }) }, latestLedger: 1_000 },
    });

    expect(code).toBe(0);
    expect(stdout).toContain(`Claimed task 7 as ${KEEPER}.`);
    // 990 + 100: the contract releases the lock once the sequence reaches it.
    expect(stdout).toContain("Lock expires at ledger 1090 (90 ledgers from ledger 1000, about 7m 30s).");
    expect(stdout).toContain("skn task execute 7 --proof <hex>");
  });

  it("still succeeds when the claim lands but reading the expiry back fails", async () => {
    const { code, stdout, stderr, rpc } = await runCli(["task", "claim", "7", ...ON], {
      env: ENV,
      rpc: { simulationErrors: { get_task: "upstream connect error" } },
    });

    expect(code).toBe(0);
    expect(rpc.submitted).toHaveLength(1);
    expect(stdout).toContain("Claimed task 7");
    expect(stderr).toContain("warning: could not read the lock expiry");
  });

  it.each([
    [9, "locked by another keeper's claim"],
    [6, "deadline has passed"],
  ])("treats contract error #%i as a routine rejection with the contract exit code", async (code, message) => {
    const result = await runCli(["task", "claim", "7", ...ON], {
      env: ENV,
      rpc: { simulationErrors: { claim_task: contractError(code) } },
    });

    expect(result.code).toBe(3);
    expect(result.stderr).toContain(message);
    expect(result.stderr).toContain("Nothing was submitted");
    expect(result.rpc.submitted).toHaveLength(0);
  });

  it("exits with the contract code for any other contract error", async () => {
    const result = await runCli(["task", "claim", "404", ...ON], {
      env: ENV,
      rpc: { simulationErrors: { claim_task: contractError(4) } },
    });

    expect(result.code).toBe(3);
    expect(result.stderr).toContain("TaskNotFound");
  });

  it("exits with the RPC code when the call never reaches a contract verdict", async () => {
    const result = await runCli(["task", "claim", "7", ...ON], {
      env: ENV,
      rpc: { simulationErrors: { claim_task: "upstream connect error" } },
    });

    expect(result.code).toBe(4);
  });

  it.each(["seven", "1.5", "18446744073709551616"])("rejects task ID %s locally", async (id) => {
    const result = await runCli(["task", "claim", id, ...ON], { env: ENV });

    expect(result.code).toBe(2);
    expect(result.stderr).toContain("Invalid task ID");
    expect(result.rpc.calls).toHaveLength(0);
  });

  it.each(["http://rpc.example.org", "not a url"])("rejects RPC URL %s before loading a key", async (url) => {
    const result = await runCli(["task", "claim", "7", "--rpc-url", url, ...ON]);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain(url);
    expect(result.rpc.calls).toHaveLength(0);
  });

  it("rejects a negative task ID, which the parser reads as an unknown option", async () => {
    const result = await runCli(["task", "claim", "-1", ...ON], { env: ENV });

    expect(result.code).toBe(2);
    expect(result.rpc.calls).toHaveLength(0);
  });
});

describe("skn task execute", () => {
  const SUCCESS = {
    results: { get_task: rawTask({ reward: 5_000_000n }), get_fee_bps: 500, dispute_window: 0 },
  };

  it("submits a hex proof and reports the reward credited net of the protocol fee", async () => {
    const { code, stdout, rpc } = await runCli(["task", "execute", "7", "--proof", "0xDEADbeef", ...ON], {
      env: ENV,
      rpc: SUCCESS,
    });

    expect(code).toBe(0);
    const execute = rpc.calls.find((call) => call.method === "execute_task");
    expect(execute?.args.slice(0, 2)).toEqual([KEEPER, 7n]);
    expect(Buffer.from(execute?.args[2] as Uint8Array).toString("hex")).toBe("deadbeef");
    expect(rpc.submitted).toHaveLength(1);
    expect(stdout).toContain(`Executed task 7 as ${KEEPER}.`);
    // split_reward: fee = 5_000_000 * 500 / 10_000 = 250_000.
    expect(stdout).toContain("Reward credited: 4750000 (task reward 5000000, protocol fee 250000 at 500 bps).");
    expect(stdout).toContain("withdrawable now");
  });

  it("rounds the fee down the way the contract's integer division does", async () => {
    const { stdout } = await runCli(["task", "execute", "7", "--proof", "ab", ...ON], {
      env: ENV,
      rpc: { results: { get_task: rawTask({ reward: 999n }), get_fee_bps: 30, dispute_window: 0 } },
    });

    // 999 * 30 / 10_000 = 2.997, truncated to 2.
    expect(stdout).toContain("Reward credited: 997 (task reward 999, protocol fee 2 at 30 bps).");
  });

  it("says when the credit is held for a dispute window", async () => {
    const { stdout } = await runCli(["task", "execute", "7", "--proof", "ab", ...ON], {
      env: ENV,
      rpc: { results: { ...SUCCESS.results, dispute_window: 120 } },
    });

    expect(stdout).toContain("pending credit for the 120-ledger dispute window");
  });

  it("still reports the credit against a contract without dispute_window", async () => {
    const { code, stdout } = await runCli(["task", "execute", "7", "--proof", "ab", ...ON], {
      env: ENV,
      rpc: { results: SUCCESS.results, simulationErrors: { dispute_window: "unknown function" } },
    });

    expect(code).toBe(0);
    expect(stdout).toContain("Reward credited: 4750000");
  });

  it("reads the proof from a file, ignoring surrounding whitespace", async () => {
    const path = join(await tempDir(), "proof.hex");
    await writeFile(path, "\n  0x0102ff  \n");

    const { code, rpc } = await runCli(["task", "execute", "7", "--proof-file", path, ...ON], {
      env: ENV,
      rpc: SUCCESS,
    });

    expect(code).toBe(0);
    const execute = rpc.calls.find((call) => call.method === "execute_task");
    expect(Buffer.from(execute?.args[2] as Uint8Array).toString("hex")).toBe("0102ff");
  });

  it.each([
    ["neither proof option", [], "exactly one of"],
    ["both proof options", ["--proof", "ab", "--proof-file", "p"], "exactly one of"],
    ["non-hex text", ["--proof", "hello!"], "non-hex characters"],
    ["an odd-length hex string", ["--proof", "abc"], "odd length"],
    ["an oversized proof", ["--proof", "ab".repeat(MAX_PROOF_LEN + 1)], `${MAX_PROOF_LEN}-byte limit`],
    ["a missing proof file", ["--proof-file", "does-not-exist.hex"], "no such file"],
  ])("rejects %s locally, before loading a key or calling the RPC", async (_label, extra, message) => {
    // No key configured: proof validation must fail first.
    const result = await runCli(["task", "execute", "7", ...extra, ...ON]);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain(message);
    expect(result.rpc.calls).toHaveLength(0);
  });

  it.each([
    [5, "not in the Claimed state"],
    [12, "claimed by another keeper"],
    [6, "deadline has passed"],
    [24, "verifier rejected this proof"],
  ])("treats contract error #%i as a routine rejection with the contract exit code", async (code, message) => {
    const result = await runCli(["task", "execute", "7", "--proof", "ab", ...ON], {
      env: ENV,
      rpc: { results: SUCCESS.results, simulationErrors: { execute_task: contractError(code) } },
    });

    expect(result.code).toBe(3);
    expect(result.stderr).toContain(message);
    expect(result.stdout).not.toContain("Reward credited");
    expect(result.rpc.submitted).toHaveLength(0);
  });

  it("requires --confirm-mainnet on mainnet", async () => {
    const result = await runCli(["task", "execute", "7", "--proof", "ab", "--profile", "mainnet", ...ON], {
      env: ENV,
    });

    expect(result.code).toBe(2);
    expect(result.stderr).toContain("--confirm-mainnet");
    expect(result.rpc.calls).toHaveLength(0);
  });
});
