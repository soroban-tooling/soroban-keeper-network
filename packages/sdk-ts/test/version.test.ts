import { describe, it } from "node:test";
import assert from "node:assert";
import {
  COMPATIBLE_CONTRACT_VERSIONS,
  checkContractCompatibility,
  compatibilityWarning,
} from "../src/version.js";

describe("checkContractCompatibility", () => {
  it("reports compatible when the contract version is in the declared range", () => {
    const known = COMPATIBLE_CONTRACT_VERSIONS[0];
    const result = checkContractCompatibility(known);
    assert.strictEqual(result.compatible, true);
    assert.strictEqual(result.contractVersion, known);
  });

  it("reports incompatible for a contract version outside the declared range", () => {
    const outOfRange = Math.max(...COMPATIBLE_CONTRACT_VERSIONS) + 100;
    const result = checkContractCompatibility(outOfRange);
    assert.strictEqual(result.compatible, false);
  });

  it("reports incompatible when the contract version could not be determined", () => {
    const result = checkContractCompatibility(undefined);
    assert.strictEqual(result.compatible, false);
    assert.strictEqual(result.contractVersion, undefined);
  });
});

describe("compatibilityWarning", () => {
  it("returns undefined for a compatible result", () => {
    const result = checkContractCompatibility(COMPATIBLE_CONTRACT_VERSIONS[0]);
    assert.strictEqual(compatibilityWarning(result), undefined);
  });

  it("returns a message naming both versions for an incompatible-but-known contract version", () => {
    const result = checkContractCompatibility(999);
    const warning = compatibilityWarning(result);
    assert.ok(warning);
    assert.match(warning!, /999/);
    assert.match(warning!, /VERSIONING\.md/);
  });

  it("returns a distinct message when the contract version could not be determined at all", () => {
    const result = checkContractCompatibility(undefined);
    const warning = compatibilityWarning(result);
    assert.ok(warning);
    assert.match(warning!, /could not determine/);
  });
});
