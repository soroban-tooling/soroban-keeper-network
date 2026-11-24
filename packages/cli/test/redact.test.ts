import { describe, expect, it } from "vitest";
import { KeeperRpcError } from "@soroban-keeper-network/sdk";
import { run } from "../src/cli.js";
import { commandError } from "../src/failures.js";
import { redactSecrets } from "../src/redact.js";
import { EXIT } from "../src/exitCodes.js";
import { TEST_SECRET } from "./support/env.js";

describe("redactSecrets", () => {
  it("drops user info, query strings and secret seeds", () => {
    expect(
      redactSecrets(`GET https://user:apikey@rpc.example.com/api?token=secret failed`),
    ).toBe("GET https://rpc.example.com/api failed");
    expect(redactSecrets(`key ${TEST_SECRET} was used`)).toBe(
      "key [REDACTED] was used",
    );
  });

  it("leaves ordinary URLs and text untouched", () => {
    expect(redactSecrets("rpc url: https://rpc.example.com/ status 200")).toBe(
      "rpc url: https://rpc.example.com/ status 200",
    );
    expect(redactSecrets("no credentials here")).toBe("no credentials here");
  });
});

describe("operator-facing output", () => {
  it("redacts a credentialed RPC URL in config show, text and JSON", async () => {
    const rpcUrl = "https://user:apikey@rpc.example.com/api?token=secret";
    const options = { env: {}, homeDir: "/nonexistent", platform: "linux" as const };

    const text = await run(["config", "show", "--rpc-url", rpcUrl], options);
    expect(text.exitCode).toBe(EXIT.ok);
    expect(text.stdout).not.toContain("apikey");
    expect(text.stdout).not.toContain("secret");
    expect(text.stdout).toContain("https://rpc.example.com/api");

    const json = await run(["config", "show", "--rpc-url", rpcUrl, "--json"], options);
    expect(json.exitCode).toBe(EXIT.ok);
    expect(json.stdout).not.toContain("apikey");
    expect(JSON.parse(json.stdout).rpcUrl).toBe("https://rpc.example.com/api");
  });

  it("redacts credentials quoted in an RPC error message", () => {
    const err = new KeeperRpcError(
      `getEvents failed at https://user:key@rpc.example.com/api?token=secret`,
    );
    const result = commandError(err, false);
    expect(result.exitCode).toBe(EXIT.rpc);
    expect(result.stderr).not.toContain("key@");
    expect(result.stderr).not.toContain("token=secret");
    expect(result.stderr).toContain("https://rpc.example.com/api");
  });
});
