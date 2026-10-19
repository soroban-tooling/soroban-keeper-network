import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { NETWORK_PRESETS } from "@soroban-keeper-network/sdk";
import { describe, expect, it } from "vitest";

import { CONTRACT_ID, SECRET, rawTask, runCli, tempDir } from "./harness.js";

const OTHER_CONTRACT = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";

async function configFile(contents: unknown): Promise<string> {
  const path = join(await tempDir(), "config.json");
  await writeFile(path, typeof contents === "string" ? contents : JSON.stringify(contents));
  return path;
}

describe("skn config init", () => {
  it("writes testnet, futurenet and mainnet profiles seeded from NETWORK_PRESETS", async () => {
    const path = join(await tempDir(), "nested", "config.json");

    const { code, stdout } = await runCli(["config", "init", "--config", path]);

    expect(code).toBe(0);
    expect(stdout).toContain(`Wrote ${path}`);
    const written = JSON.parse(await readFile(path, "utf8"));
    expect(written.defaultProfile).toBe("testnet");
    expect(Object.keys(written.profiles)).toEqual(["testnet", "futurenet", "mainnet"]);
    for (const name of ["testnet", "futurenet", "mainnet"] as const) {
      expect(written.profiles[name]).toEqual({ network: name, ...NETWORK_PRESETS[name] });
    }
  });

  it("refuses to overwrite an existing file without --force", async () => {
    const path = await configFile({ profiles: { mine: {} } });

    const refused = await runCli(["config", "init", "--config", path]);
    expect(refused.code).toBe(2);
    expect(refused.stderr).toContain("already exists");
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ profiles: { mine: {} } });

    const forced = await runCli(["config", "init", "--force", "--config", path]);
    expect(forced.code).toBe(0);
    expect(Object.keys(JSON.parse(await readFile(path, "utf8")).profiles)).toHaveLength(3);
  });

  it("defaults to $SKN_CONFIG, then the user config directory", async () => {
    const viaEnv = join(await tempDir(), "env.json");
    expect((await runCli(["config", "init"], { env: { SKN_CONFIG: viaEnv } })).code).toBe(0);
    await expect(readFile(viaEnv, "utf8")).resolves.toContain("testnet");

    const home = await tempDir();
    expect((await runCli(["config", "init"], { home, platform: "linux" })).code).toBe(0);
    await expect(readFile(join(home, ".config", "skn", "config.json"), "utf8")).resolves.toContain(
      "mainnet",
    );
  });
});

describe("skn config show", () => {
  it("uses the built-in testnet profile when there is no config file", async () => {
    const { code, stdout } = await runCli(["config", "show"]);

    expect(code).toBe(0);
    expect(stdout).toContain("not found; using built-in profiles");
    expect(stdout).toMatch(/Profile:\s+testnet \[built-in default\]/);
    expect(stdout).toContain(NETWORK_PRESETS.testnet.rpcUrl);
    expect(stdout).toMatch(/Mainnet:\s+no/);
  });

  it("layers flags over the profile over the preset defaults", async () => {
    const path = await configFile({
      defaultProfile: "staging",
      profiles: {
        staging: { network: "futurenet", rpcUrl: "https://rpc.example.org", contractId: CONTRACT_ID },
      },
    });

    const fromProfile = await runCli(["config", "show", "--config", path]);
    expect(fromProfile.code).toBe(0);
    expect(fromProfile.stdout).toMatch(/Profile:\s+staging \[defaultProfile in config file\]/);
    expect(fromProfile.stdout).toContain(`https://rpc.example.org [profile "staging"]`);
    expect(fromProfile.stdout).toContain(
      `${NETWORK_PRESETS.futurenet.networkPassphrase} [default (futurenet preset)]`,
    );
    expect(fromProfile.stdout).toContain(`${CONTRACT_ID} [profile "staging"]`);

    const withFlags = await runCli([
      "config",
      "show",
      "--config",
      path,
      "--rpc-url",
      "https://flag.example.org",
      "--contract-id",
      OTHER_CONTRACT,
    ]);
    expect(withFlags.stdout).toContain("https://flag.example.org [flag]");
    expect(withFlags.stdout).toContain(`${OTHER_CONTRACT} [flag]`);
    expect(withFlags.stdout).toContain("[default (futurenet preset)]");
  });

  it("selects a profile with --profile", async () => {
    const { code, stdout } = await runCli(["config", "show", "--profile", "mainnet"]);

    expect(code).toBe(0);
    expect(stdout).toMatch(/Profile:\s+mainnet \[--profile\]/);
    expect(stdout).toContain(NETWORK_PRESETS.mainnet.rpcUrl);
    expect(stdout).toMatch(/Mainnet:\s+yes/);
  });

  it("reports an unknown profile with the available ones", async () => {
    const { code, stderr } = await runCli(["config", "show", "--profile", "nope"]);

    expect(code).toBe(2);
    expect(stderr).toContain(`Unknown profile "nope". Available profiles: testnet, futurenet, mainnet.`);
    expect(stderr).toContain("skn config init");
  });

  it.each([
    ["not JSON", "{", "not valid JSON"],
    ["a misspelled profile key", { profiles: { a: { contractID: "x" } } }, `unknown key "contractID"`],
    ["an unknown network", { profiles: { a: { network: "devnet" } } }, `"network" must be one of`],
    ["a non-string field", { profiles: { a: { rpcUrl: 1 } } }, `"rpcUrl" must be a string`],
    ["a dangling defaultProfile", { defaultProfile: "b", profiles: { a: {} } }, `names "b"`],
  ])("rejects a config file with %s", async (_label, contents, message) => {
    const path = await configFile(contents);

    const { code, stderr } = await runCli(["config", "show", "--config", path]);

    expect(code).toBe(2);
    expect(stderr).toContain(path);
    expect(stderr).toContain(message);
  });
});

describe("mainnet confirmation", () => {
  const claimArgs = ["task", "claim", "7", "--contract-id", CONTRACT_ID];

  it("refuses to send a mainnet transaction without --confirm-mainnet, before any RPC call", async () => {
    const { code, stderr, rpc } = await runCli([...claimArgs, "--profile", "mainnet"], {
      env: { SKN_SECRET_KEY: SECRET },
    });

    expect(code).toBe(2);
    expect(stderr).toContain("--confirm-mainnet");
    expect(rpc.calls).toHaveLength(0);
  });

  it("detects mainnet by passphrase, whatever the profile is called", async () => {
    const path = await configFile({
      profiles: { prod: { networkPassphrase: NETWORK_PRESETS.mainnet.networkPassphrase } },
    });

    const { code, stderr } = await runCli([...claimArgs, "--config", path, "--profile", "prod"], {
      env: { SKN_SECRET_KEY: SECRET },
    });

    expect(code).toBe(2);
    expect(stderr).toContain(`mainnet (profile "prod")`);
  });

  it("proceeds with --confirm-mainnet", async () => {
    const { code, rpc } = await runCli(
      [...claimArgs, "--profile", "mainnet", "--confirm-mainnet"],
      { env: { SKN_SECRET_KEY: SECRET }, rpc: { results: { get_task: rawTask() } } },
    );

    expect(code).toBe(0);
    expect(rpc.submitted).toHaveLength(1);
  });

  it("is not required off mainnet", async () => {
    const { code } = await runCli(claimArgs, {
      env: { SKN_SECRET_KEY: SECRET },
      rpc: { results: { get_task: rawTask() } },
    });

    expect(code).toBe(0);
  });
});

describe("contract ID", () => {
  it("is required by task commands, with a pointer to where to set it", async () => {
    const { code, stderr, rpc } = await runCli(["task", "claim", "7"], {
      env: { SKN_SECRET_KEY: SECRET },
    });

    expect(code).toBe(2);
    expect(stderr).toContain("--contract-id");
    expect(rpc.calls).toHaveLength(0);
  });

  it("is read from the profile", async () => {
    const path = await configFile({ profiles: { testnet: { contractId: CONTRACT_ID } } });

    const { code } = await runCli(["task", "claim", "7", "--config", path], {
      env: { SKN_SECRET_KEY: SECRET },
      rpc: { results: { get_task: rawTask() } },
    });

    expect(code).toBe(0);
  });
});
