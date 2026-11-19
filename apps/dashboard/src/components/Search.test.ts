import { describe, expect, it } from "vitest";
import { parseSearchQuery } from "./Search";

describe("parseSearchQuery", () => {
  it("routes numeric input to task page", () => {
    const res1 = parseSearchQuery("42");
    expect(res1.type).toBe("task");
    if (res1.type === "task") {
      expect(res1.taskId).toBe(42);
      expect(res1.path).toBe("/tasks/42");
    }

    const res2 = parseSearchQuery("#123");
    expect(res2.type).toBe("task");
    if (res2.type === "task") {
      expect(res2.taskId).toBe(123);
      expect(res2.path).toBe("/tasks/123");
    }

    const res3 = parseSearchQuery("  0  ");
    expect(res3.type).toBe("task");
    if (res3.type === "task") {
      expect(res3.taskId).toBe(0);
      expect(res3.path).toBe("/tasks/0");
    }
  });

  it("routes 56-character Stellar 'G...' addresses to owner and keeper routes", () => {
    const validAddr = "GBVOLK4B7YUGP645L73K6G223OIGT2M3QG77GQCYUXLWB266V266F53J";
    const res = parseSearchQuery(validAddr);

    expect(res.type).toBe("address");
    if (res.type === "address") {
      expect(res.address).toBe(validAddr);
      expect(res.ownerPath).toBe(`/owners/${validAddr}`);
      expect(res.keeperPath).toBe(`/keepers/${validAddr}`);
    }

    // lowercase address also gets normalized
    const lowerAddr = validAddr.toLowerCase();
    const resLower = parseSearchQuery(lowerAddr);
    expect(resLower.type).toBe("address");
    if (resLower.type === "address") {
      expect(resLower.address).toBe(validAddr);
    }
  });

  it("returns helpful messages for invalid inputs", () => {
    // Empty
    const emptyRes = parseSearchQuery("   ");
    expect(emptyRes.type).toBe("invalid");
    if (emptyRes.type === "invalid") {
      expect(emptyRes.error).toContain("Enter a task ID");
    }

    // Partial Stellar address
    const partialRes = parseSearchQuery("GBVOLK4B7");
    expect(partialRes.type).toBe("invalid");
    if (partialRes.type === "invalid") {
      expect(partialRes.error).toContain("Incomplete address");
      expect(partialRes.error).toContain("56 characters");
    }

    // Mixed invalid alpha-numeric string
    const mixedRes = parseSearchQuery("task-foo-99");
    expect(mixedRes.type).toBe("invalid");
    if (mixedRes.type === "invalid") {
      expect(mixedRes.error).toContain("Invalid format");
    }

    // Random symbols
    const symRes = parseSearchQuery("???!!");
    expect(symRes.type).toBe("invalid");
    if (symRes.type === "invalid") {
      expect(symRes.error).toContain("No matching destination");
    }
  });
});
