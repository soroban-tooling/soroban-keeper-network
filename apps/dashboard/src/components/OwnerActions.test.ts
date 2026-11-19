import { describe, expect, it } from "vitest";
import { plainContractError } from "./OwnerActions";

describe("plainContractError", () => {
  it("translates authorization failures", () => {
    expect(plainContractError(new Error("HostError: unauthorized invocation"))).toContain("not authorized");
  });

  it("does not expose unknown contract internals", () => {
    expect(plainContractError(new Error("rpc xdr trap 0xdeadbeef"))).toBe(
      "The contract rejected the transaction. Refresh the task and try again.",
    );
  });
});
