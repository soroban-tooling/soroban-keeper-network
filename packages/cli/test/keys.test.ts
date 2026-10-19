import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { Keypair } from "@stellar/stellar-sdk";
import type { Command } from "commander";
import { describe, expect, it } from "vitest";

import { buildProgram } from "../src/cli.js";
import { createContext, SecretRedactor } from "../src/context.js";
import { assertPrivateKeyFileMode } from "../src/keys.js";
import {
  CONTRACT_ID,
  KEEPER,
  SECRET,
  contractError,
  rawTask,
  runCli,
  tempDir,
  type RunOptions,
} from "./harness.js";

const OTHER = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 9));
const CLAIM = ["task", "claim", "7", "--contract-id", CONTRACT_ID];
const SUCCESS = { results: { get_task: rawTask() } };

/** A key file only its owner can access (the mode is ignored on Windows). */
async function privateKeyFile(contents = SECRET): Promise<string> {
  const path = join(await tempDir(), "keeper.key");
  await writeFile(path, `${contents}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
  return path;
}

async function identity(name: string, toml: string): Promise<string> {
  const cwd = await tempDir();
  await mkdir(join(cwd, ".stellar", "identity"), { recursive: true });
  await writeFile(join(cwd, ".stellar", "identity", `${name}.toml`), toml);
  return cwd;
}

/** The `G...` the claim was signed as, from the first recorded call. */
function claimedAs(result: Awaited<ReturnType<typeof runCli>>): unknown {
  return result.rpc.calls[0]?.args[0];
}

describe("key sources", () => {
  it("reads SKN_SECRET_KEY", async () => {
    const result = await runCli(CLAIM, { env: { SKN_SECRET_KEY: SECRET }, rpc: SUCCESS });

    expect(result.code).toBe(0);
    expect(claimedAs(result)).toBe(KEEPER);
  });

  it("reads a private --key-file, ignoring surrounding whitespace", async () => {
    const path = await privateKeyFile(`  ${SECRET}  `);

    const result = await runCli([...CLAIM, "--key-file", path], { rpc: SUCCESS });

    expect(result.stderr).toBe("");
    expect(claimedAs(result)).toBe(KEEPER);
  });

  it("reads a Stellar CLI identity from the project-local store", async () => {
    const cwd = await identity("alice", `secret_key = "${SECRET}"\n`);

    const result = await runCli([...CLAIM, "--identity", "alice"], { cwd, rpc: SUCCESS });

    expect(result.stderr).toBe("");
    expect(claimedAs(result)).toBe(KEEPER);
  });

  it("reads a Stellar CLI identity from the user-wide store", async () => {
    const home = await tempDir();
    await mkdir(join(home, ".config", "stellar", "identity"), { recursive: true });
    await writeFile(join(home, ".config", "stellar", "identity", "bob.toml"), `secret_key = "${SECRET}"\n`);

    const result = await runCli([...CLAIM, "--identity", "bob"], { home, rpc: SUCCESS });

    expect(claimedAs(result)).toBe(KEEPER);
  });

  it("prefers --key-file, then --identity, over SKN_SECRET_KEY", async () => {
    const env = { SKN_SECRET_KEY: OTHER.secret() };

    const viaFile = await runCli([...CLAIM, "--key-file", await privateKeyFile()], { env, rpc: SUCCESS });
    expect(claimedAs(viaFile)).toBe(KEEPER);

    const cwd = await identity("alice", `secret_key = "${SECRET}"\n`);
    const viaIdentity = await runCli([...CLAIM, "--identity", "alice"], { env, cwd, rpc: SUCCESS });
    expect(claimedAs(viaIdentity)).toBe(KEEPER);
  });

  it("refuses --key-file and --identity together", async () => {
    const result = await runCli([...CLAIM, "--key-file", "k", "--identity", "alice"]);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain("mutually exclusive");
    expect(result.rpc.calls).toHaveLength(0);
  });

  it("explains every source when no key is configured", async () => {
    const result = await runCli(CLAIM);

    expect(result.code).toBe(2);
    for (const source of ["SKN_SECRET_KEY", "--key-file", "--identity"]) {
      expect(result.stderr).toContain(source);
    }
  });

  it("explains a seed-phrase identity it cannot use", async () => {
    const phrase = "abandon ".repeat(11) + "about";
    const cwd = await identity("carol", `seed_phrase = "${phrase}"\n`);

    const result = await runCli([...CLAIM, "--identity", "carol"], { cwd });

    expect(result.code).toBe(2);
    expect(result.stderr).toContain("seed phrase");
    expect(result.output).not.toContain(phrase);
  });

  it("lists where it looked for a missing identity", async () => {
    const result = await runCli([...CLAIM, "--identity", "nobody"]);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain(join(".stellar", "identity", "nobody.toml"));
  });

  it("rejects an identity name that could escape the identity directory", async () => {
    const result = await runCli([...CLAIM, "--identity", "../../etc/passwd"]);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain("Invalid identity name");
  });
});

describe("key file permissions", () => {
  it("refuses a key file other users can read, with the fix", async () => {
    const path = join(await tempDir(), "shared.key");
    await writeFile(path, SECRET);
    await chmod(path, 0o644);

    // Forced to a POSIX platform so the check also runs on a Windows host,
    // where stat() reports 0o666 for this file.
    const result = await runCli([...CLAIM, "--key-file", path], { platform: "linux" });

    expect(result.code).toBe(2);
    expect(result.stderr).toContain(`Refusing to use key file ${path}`);
    expect(result.stderr).toContain(`chmod 600 ${path}`);
    expect(result.output).not.toContain(SECRET);
    expect(result.rpc.calls).toHaveLength(0);
  });

  it.each([
    [0o600, true],
    [0o400, true],
    [0o640, false],
    [0o604, false],
    [0o620, false],
    [0o602, false],
    [0o644, false],
  ])("on POSIX, mode %o is accepted: %s", (mode, accepted) => {
    const check = (): void => assertPrivateKeyFileMode(0o100000 | mode, "linux", "/k");
    if (accepted) expect(check).not.toThrow();
    else expect(check).toThrow(/Refusing to use key file/);
  });

  it("skips the mode check on Windows, where mode bits do not describe access", () => {
    expect(() => assertPrivateKeyFileMode(0o100666, "win32", "C:\\k")).not.toThrow();
  });
});

describe("secrets never appear in output", () => {
  function leafCommands(): string[][] {
    const program = buildProgram(
      createContext(
        { stdout: () => {}, stderr: () => {}, env: {}, cwd: ".", homedir: ".", platform: "linux" },
        new SecretRedactor(),
      ),
    );
    const leaves: string[][] = [];
    const walk = (command: Command, prefix: string[]): void => {
      for (const child of command.commands) {
        const path = [...prefix, child.name()];
        if (child.commands.length === 0) leaves.push(path);
        else walk(child, path);
      }
    };
    walk(program, []);
    return leaves;
  }

  /** Arguments that get each leaf command past its own validation. */
  const VALID_ARGS: Record<string, string[]> = {
    "task claim": ["7"],
    "task execute": ["7", "--proof", "abcd"],
  };

  const EVERY_METHOD_FAILS = Object.fromEntries(
    ["claim_task", "execute_task", "get_task", "get_fee_bps", "dispute_window"].map((method) => [
      method,
      contractError(2),
    ]),
  );

  async function keySetups(): Promise<[string, string[], RunOptions][]> {
    const keyFile = await privateKeyFile();
    const cwd = await identity("alice", `secret_key = "${SECRET}"\n`);
    return [
      ["SKN_SECRET_KEY", [], { env: { SKN_SECRET_KEY: SECRET } }],
      ["--key-file", ["--key-file", keyFile], {}],
      ["--identity", ["--identity", "alice"], { cwd }],
    ];
  }

  it("for every command, key source and outcome, including errors", async () => {
    const leaves = leafCommands();
    expect(leaves.length).toBeGreaterThan(0);

    let runs = 0;
    for (const [source, keyArgs, base] of await keySetups()) {
      for (const leaf of leaves) {
        const args = VALID_ARGS[leaf.join(" ")] ?? [];
        const scenarios: [string, string[], RunOptions][] = [
          ["help", [...leaf, "--help"], base],
          ["missing arguments", [...leaf], base],
          ["unknown option", [...leaf, ...args, "--bogus"], base],
          ["success", [...leaf, ...args, "--contract-id", CONTRACT_ID], { ...base, rpc: SUCCESS }],
          [
            "contract error",
            [...leaf, ...args, "--contract-id", CONTRACT_ID],
            { ...base, rpc: { simulationErrors: EVERY_METHOD_FAILS } },
          ],
          ["mainnet refusal", [...leaf, ...args, "--contract-id", CONTRACT_ID, "--profile", "mainnet"], base],
        ];
        for (const [label, argv, options] of scenarios) {
          const result = await runCli([...argv, ...keyArgs], options);
          runs += 1;
          expect(result.output, `${source} / ${leaf.join(" ")} / ${label}`).not.toContain(SECRET);
        }
      }
    }
    expect(runs).toBe(3 * leaves.length * 6);
  });

  it("when the key itself is invalid", async () => {
    const invalid = `S${"Q".repeat(55)}`;
    const keyFile = await privateKeyFile(invalid);

    for (const options of [
      { argv: CLAIM, env: { SKN_SECRET_KEY: invalid } },
      { argv: [...CLAIM, "--key-file", keyFile], env: {} },
    ]) {
      const result = await runCli(options.argv, { env: options.env });
      expect(result.code).toBe(2);
      expect(result.stderr).toContain("not a valid Stellar secret seed");
      expect(result.output).not.toContain(invalid);
    }
  });

  it("when a secret is passed as an argument, refusing it before parsing", async () => {
    for (const argv of [
      ["task", "claim", SECRET],
      ["task", "claim", "7", "--key-file", SECRET],
      ["task", "claim", "7", `--identity=${SECRET}`],
      ["--bogus", SECRET],
    ]) {
      const result = await runCli(argv);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain("looks like a Stellar secret key");
      expect(result.output).not.toContain(SECRET);
      expect(result.rpc.calls).toHaveLength(0);
    }
  });

  it("when a contract error message echoes the secret, the redactor removes it", async () => {
    // A worst case no real RPC produces: proves the output path redacts even
    // if a dependency's error message ever included key material.
    const result = await runCli(CLAIM, {
      env: { SKN_SECRET_KEY: SECRET },
      rpc: { simulationErrors: { claim_task: `${contractError(2)} signer ${SECRET}` } },
    });

    expect(result.code).not.toBe(0);
    expect(result.output).not.toContain(SECRET);
  });
});
