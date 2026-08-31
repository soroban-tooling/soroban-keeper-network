import { describe, it } from "node:test";
import assert from "node:assert";
import {
  KeeperErrorCode,
  decodeKeeperError,
  isKeeperError,
} from "../src/errors.js";

describe("decodeKeeperError", () => {
  it("decodes a known contract error from a real-shaped Soroban error message", () => {
    const error = new Error(
      "Simulation failed: HostError: Error(Contract, #4)\nEvent log ...",
    );
    const decoded = decodeKeeperError(error);
    assert.deepStrictEqual(decoded, {
      code: 4,
      name: "TaskNotFound",
    });
  });

  it("decodes every named KeeperErrorCode variant correctly", () => {
    for (const [name, code] of Object.entries(KeeperErrorCode)) {
      if (typeof code !== "number") continue;
      const error = new Error(`Error(Contract, #${code})`);
      const decoded = decodeKeeperError(error);
      assert.strictEqual(decoded?.code, code);
      assert.strictEqual(decoded?.name, name);
    }
  });

  it("returns code with name undefined for a numeric code outside the known enum", () => {
    const error = new Error("Error(Contract, #9999)");
    const decoded = decodeKeeperError(error);
    assert.deepStrictEqual(decoded, { code: 9999, name: undefined });
  });

  it("returns undefined when the message has no Error(Contract, #n) pattern at all", () => {
    const error = new Error("Send failed: network timeout");
    assert.strictEqual(decodeKeeperError(error), undefined);
  });

  it("returns undefined for a non-Error thrown value with no matching pattern", () => {
    assert.strictEqual(decodeKeeperError("plain string, no pattern"), undefined);
  });

  it("still matches when the thrown value is a string containing the pattern", () => {
    const decoded = decodeKeeperError("prefix Error(Contract, #2) suffix");
    assert.deepStrictEqual(decoded, { code: 2, name: "Unauthorized" });
  });

  it("does not match a similarly-shaped but different error type (e.g. WasmVm)", () => {
    const error = new Error("Error(WasmVm, #1)");
    assert.strictEqual(decodeKeeperError(error), undefined);
  });
});

describe("isKeeperError", () => {
  it("returns true when the error decodes to the exact code checked", () => {
    const error = new Error("Error(Contract, #4)");
    assert.strictEqual(isKeeperError(error, KeeperErrorCode.TaskNotFound), true);
  });

  it("returns false when the error decodes to a different code", () => {
    const error = new Error("Error(Contract, #2)");
    assert.strictEqual(isKeeperError(error, KeeperErrorCode.TaskNotFound), false);
  });

  it("returns false when the error doesn't decode at all", () => {
    const error = new Error("some unrelated failure");
    assert.strictEqual(isKeeperError(error, KeeperErrorCode.TaskNotFound), false);
  });
});
