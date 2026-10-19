import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KeyError, resolveKey, type KeyContext } from "../src/keys.js";
import { jsonResult, toJsonSafe } from "../src/output.js";
import { TEST_SECRET, scratchDir } from "./support/env.js";

let dir: string;
let cleanup: () => Promise<void>;

beforeEach(async () => {
  ({ dir, cleanup } = await scratchDir());
});

afterEach(async () => {
  await cleanup();
});

function context(env: NodeJS.ProcessEnv = {}, platform: NodeJS.Platform = "linux"): KeyContext {
  return { env, homeDir: dir, platform };
}

describe("resolveKey: sources and precedence", () => {
  it("returns undefined when no source is set", async () => {
    expect(await resolveKey({}, context())).toBeUndefined();
  });

  it("reads SKN_SECRET_KEY from the environment", async () => {
    const key = await resolveKey({}, context({ SKN_SECRET_KEY: TEST_SECRET }));

    expect(key).toEqual({ source: "env", origin: "SKN_SECRET_KEY", secret: TEST_SECRET });
  });

  it("rejects a malformed SKN_SECRET_KEY without echoing its value", async () => {
    const error = await resolveKey({}, context({ SKN_SECRET_KEY: "SNOTVALID-leaky" })).catch(
      (err: unknown) => err,
    );

    expect(error).toBeInstanceOf(KeyError);
    expect((error as Error).message).toBe("SKN_SECRET_KEY is not a valid secret key");
  });

  it("prefers --key-file over --identity over SKN_SECRET_KEY", async () => {
    const keyFile = join(dir, "key.txt");
    await writeFile(keyFile, TEST_SECRET, "utf8");
    await chmod(keyFile, 0o600);

    // Platform is win32 so the file-mode check does not depend on the test machine.
    const key = await resolveKey(
      { keyFile, identity: "alice" },
      context({ SKN_SECRET_KEY: TEST_SECRET }, "win32"),
    );

    expect(key?.source).toBe("key-file");
  });

  it("reads a Stellar CLI identity's secret_key", async () => {
    const identityDir = join(dir, ".config", "stellar", "identity");
    await mkdir(identityDir, { recursive: true });
    await writeFile(
      join(identityDir, "alice.toml"),
      `seed_phrase = ""\nsecret_key = "${TEST_SECRET}"\n`,
      "utf8",
    );

    const key = await resolveKey({ identity: "alice" }, context());

    expect(key).toEqual({ source: "identity", origin: "alice", secret: TEST_SECRET });
  });

  it("refuses an identity name that could escape the identity directory", async () => {
    await expect(resolveKey({ identity: "../../etc/passwd" }, context())).rejects.toThrow(
      "may only contain letters, digits",
    );
  });

  it("explains an identity that holds only a seed phrase", async () => {
    const identityDir = join(dir, ".config", "stellar", "identity");
    await mkdir(identityDir, { recursive: true });
    await writeFile(join(identityDir, "bob.toml"), `seed_phrase = "words"\n`, "utf8");

    await expect(resolveKey({ identity: "bob" }, context())).rejects.toThrow(
      "seed-phrase identities are not supported yet",
    );
  });
});

describe("resolveKey: key file permissions", () => {
  it("refuses a key file readable by other users", async () => {
    const keyFile = join(dir, "key.txt");
    await writeFile(keyFile, TEST_SECRET, "utf8");
    await chmod(keyFile, 0o644);

    // Forced to the POSIX platform so the check runs on every machine.
    await expect(resolveKey({ keyFile }, context({}, "linux"))).rejects.toThrow(
      "is readable by other users; restrict it with chmod 600",
    );
  });

  it.skipIf(process.platform === "win32")("accepts a key file only its owner can read", async () => {
    const keyFile = join(dir, "key.txt");
    await writeFile(keyFile, TEST_SECRET, "utf8");
    await chmod(keyFile, 0o600);

    const key = await resolveKey({ keyFile }, context({}, "linux"));

    expect(key?.secret).toBe(TEST_SECRET);
  });

  it("rejects a key file whose contents are not a secret, without echoing them", async () => {
    const keyFile = join(dir, "key.txt");
    await writeFile(keyFile, "contents-that-must-not-leak", "utf8");

    const error = await resolveKey({ keyFile }, context({}, "win32")).catch((err: unknown) => err);

    expect((error as Error).message).toContain("does not contain a valid secret key");
    expect((error as Error).message).not.toContain("contents-that-must-not-leak");
  });
});

describe("JSON output", () => {
  it("serializes bigints as decimal strings, nested or not", () => {
    expect(
      toJsonSafe({ reward: 123456789012345678901234567890n, tasks: [{ id: 7n }], note: "ok" }),
    ).toEqual({ reward: "123456789012345678901234567890", tasks: [{ id: "7" }], note: "ok" });
  });

  it("prints a parseable document from jsonResult", () => {
    const result = jsonResult({ amount: 10n ** 20n });

    expect(JSON.parse(result.stdout)).toEqual({ amount: "100000000000000000000" });
    expect(result.exitCode).toBe(0);
  });
});
