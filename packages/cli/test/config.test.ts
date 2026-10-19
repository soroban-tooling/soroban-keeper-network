import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { run, type RunOptions } from "../src/cli.js";
import { EXIT } from "../src/exitCodes.js";
import { requireMainnetConfirmation, type Settings } from "../src/settings.js";
import { CONTRACT_ID, TEST_SECRET, scratchDir } from "./support/env.js";

let dir: string;
let cleanup: () => Promise<void>;
let configFile: string;

beforeEach(async () => {
  ({ dir, cleanup } = await scratchDir());
  configFile = join(dir, "skn.config.json");
});

afterEach(async () => {
  await cleanup();
});

/** Options that point the CLI at this test's directory instead of the real home. */
function options(extraEnv: NodeJS.ProcessEnv = {}): RunOptions {
  return {
    env: { SKN_CONFIG: configFile, ...extraEnv },
    homeDir: dir,
    platform: "linux",
  };
}

async function writeConfigFile(value: unknown): Promise<void> {
  await writeFile(configFile, JSON.stringify(value), "utf8");
}

describe("skn config init", () => {
  it("writes a config with testnet, futurenet and mainnet profiles", async () => {
    const result = await run(["config", "init"], options());

    expect(result.exitCode).toBe(EXIT.ok);
    const written = JSON.parse(await readFile(configFile, "utf8"));
    expect(written.defaultProfile).toBe("testnet");
    expect(Object.keys(written.profiles).sort()).toEqual(["futurenet", "mainnet", "testnet"]);
    expect(written.profiles.mainnet).toEqual({ network: "mainnet" });
  });

  it("refuses to overwrite an existing file without --force", async () => {
    await writeConfigFile({ defaultProfile: "x", profiles: { x: { network: "testnet" } } });

    const refused = await run(["config", "init"], options());
    expect(refused.exitCode).toBe(EXIT.usage);
    expect(refused.stderr).toContain("pass --force to overwrite it");

    const forced = await run(["config", "init", "--force"], options());
    expect(forced.exitCode).toBe(EXIT.ok);
    const written = JSON.parse(await readFile(configFile, "utf8"));
    expect(written.defaultProfile).toBe("testnet");
  });

  it("prints the profiles it wrote with --json", async () => {
    const result = await run(["config", "init", "--json"], options());

    expect(JSON.parse(result.stdout)).toMatchObject({
      path: configFile,
      defaultProfile: "testnet",
      profiles: ["testnet", "futurenet", "mainnet"],
    });
  });
});

describe("skn config show: effective values", () => {
  it("falls back to defaults when there is no config file", async () => {
    const result = await run(["config", "show", "--json"], options());

    expect(result.exitCode).toBe(EXIT.ok);
    expect(JSON.parse(result.stdout)).toMatchObject({
      configFound: false,
      profile: null,
      network: "testnet",
      contractId: null,
      confirmMainnet: false,
      key: null,
    });
  });

  it("applies flag over profile over default", async () => {
    await writeConfigFile({
      defaultProfile: "mainnet",
      profiles: {
        mainnet: { network: "mainnet", contractId: CONTRACT_ID },
        futurenet: { network: "futurenet" },
      },
    });

    // The default profile supplies the network and contract.
    const fromProfile = await run(["config", "show", "--json"], options());
    expect(JSON.parse(fromProfile.stdout)).toMatchObject({
      profile: "mainnet",
      network: "mainnet",
      contractId: CONTRACT_ID,
    });

    // --profile selects a different profile.
    const selected = await run(["config", "show", "--profile", "futurenet", "--json"], options());
    expect(JSON.parse(selected.stdout)).toMatchObject({ profile: "futurenet", network: "futurenet" });

    // A flag overrides the profile.
    const overridden = await run(
      ["config", "show", "--profile", "futurenet", "--network", "testnet", "--contract-id", CONTRACT_ID, "--json"],
      options(),
    );
    expect(JSON.parse(overridden.stdout)).toMatchObject({
      profile: "futurenet",
      network: "testnet",
      contractId: CONTRACT_ID,
    });
  });

  it("exits 2 for a profile the config does not define", async () => {
    await writeConfigFile({ defaultProfile: "testnet", profiles: { testnet: { network: "testnet" } } });

    const result = await run(["config", "show", "--profile", "nope"], options());

    expect(result.exitCode).toBe(EXIT.usage);
    expect(result.stderr).toContain("no profile named 'nope'");
  });

  it("exits 2 when the config file is not valid JSON", async () => {
    await writeFile(configFile, "{ not json", "utf8");

    const result = await run(["config", "show"], options());

    expect(result.exitCode).toBe(EXIT.usage);
    expect(result.stderr).toContain("is not valid JSON");
  });

  it("exits 2 for a profile with an unknown network", async () => {
    await writeConfigFile({ defaultProfile: "x", profiles: { x: { network: "moonnet" } } });

    const result = await run(["config", "show"], options());

    expect(result.exitCode).toBe(EXIT.usage);
    expect(result.stderr).toContain("profile 'x' has an unknown network");
  });
});

describe("signing keys in config show", () => {
  it("reports the key's source without printing the key", async () => {
    const result = await run(["config", "show"], options({ SKN_SECRET_KEY: TEST_SECRET }));

    expect(result.exitCode).toBe(EXIT.ok);
    expect(result.stdout).toContain("signing key:       env (SKN_SECRET_KEY)");
    expect(result.stdout).not.toContain(TEST_SECRET);
    expect(result.stderr).not.toContain(TEST_SECRET);
  });

  it("never prints the secret in --json output", async () => {
    const result = await run(["config", "show", "--json"], options({ SKN_SECRET_KEY: TEST_SECRET }));

    expect(JSON.parse(result.stdout).key).toEqual({ source: "env", origin: "SKN_SECRET_KEY" });
    expect(result.stdout).not.toContain(TEST_SECRET);
  });

  it("does not print key file contents when the file is invalid", async () => {
    const keyFile = join(dir, "key.txt");
    await writeFile(keyFile, "not-a-secret-but-sensitive-looking", "utf8");

    const result = await run(["config", "show", "--key-file", keyFile, "--json"], options());

    expect(result.exitCode).toBe(EXIT.usage);
    expect(JSON.parse(result.stdout).error.code).toBe("USAGE_ERROR");
    expect(result.stdout).not.toContain("sensitive-looking");
  });
});

describe("requireMainnetConfirmation", () => {
  const base: Settings = {
    profile: "mainnet",
    network: "mainnet",
    rpcUrl: "https://mainnet.sorobanrpc.com",
    networkPassphrase: "Public Global Stellar Network ; September 2015",
    contractId: CONTRACT_ID,
    confirmMainnet: false,
  };

  it("refuses a transaction on mainnet without --confirm-mainnet", () => {
    expect(() => requireMainnetConfirmation(base)).toThrow("pass --confirm-mainnet");
  });

  it("allows a transaction on mainnet with --confirm-mainnet", () => {
    expect(() => requireMainnetConfirmation({ ...base, confirmMainnet: true })).not.toThrow();
  });

  it("does not require the flag on testnet", () => {
    expect(() =>
      requireMainnetConfirmation({ ...base, network: "testnet", confirmMainnet: false }),
    ).not.toThrow();
  });
});
