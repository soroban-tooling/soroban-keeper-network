import { describe, expect, it } from "vitest";
import { safeErrorMessage } from "./index.js";

describe("safeErrorMessage", () => {
  it("redacts secrets from unexpected crash messages", () => {
    const secret = "SBGWKM3CD4IL47QN6X54N6Y33T3JDNVI6AIJ6CD5IM47HG3IG4O36XCU";
    const output = safeErrorMessage(new Error(`SIGNING_KEY_POOL=${secret},secondary`));
    expect(output).not.toContain(secret);
    expect(output).toContain("[REDACTED]");
  });
});
