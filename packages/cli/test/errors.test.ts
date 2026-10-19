import { KeeperErrorCode } from "@soroban-keeper-network/sdk";
import { describe, expect, it } from "vitest";
import { explainContractError } from "../src/errors.js";

/** Every numeric member of the SDK's enum. Reverse mappings for numeric enums are the names. */
const CODES = Object.keys(KeeperErrorCode)
  .filter((key) => !Number.isNaN(Number(key)))
  .map(Number);

describe("contract error explanations (#694)", () => {
  it("covers every KeeperErrorCode, so a new code cannot ship without a message", () => {
    expect(CODES.length).toBeGreaterThan(0);
    for (const code of CODES) {
      const help = explainContractError(code);
      expect(help.name).toBe(KeeperErrorCode[code]);
      expect(help.message.length).toBeGreaterThan(10);
      expect(help.hint.length).toBeGreaterThan(10);
    }
  });

  it("gives a next step that names something the person can act on", () => {
    expect(explainContractError(KeeperErrorCode.LockPeriodActive).hint).toContain("lock");
    expect(explainContractError(KeeperErrorCode.DeadlinePassed).hint).toContain("deadline");
  });

  it("explains an unknown code from a newer deployment instead of printing a bare number", () => {
    const help = explainContractError(9999);

    expect(help.name).toBe("UnknownContractError(9999)");
    expect(help.message).toContain("9999");
  });
});
