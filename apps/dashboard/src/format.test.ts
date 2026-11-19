import { describe, expect, it } from "vitest";
import {
  formatAbsoluteTime,
  formatRelativeTime,
  formatStroops,
  parseStroops,
  truncateAddress,
} from "./format";

describe("formatStroops", () => {
  it("formats zero in multiple forms", () => {
    expect(formatStroops(0n)).toBe("0.00");
    expect(formatStroops("0")).toBe("0.00");
    expect(formatStroops("-0")).toBe("0.00");
    expect(formatStroops(0n, { minDecimals: 0 })).toBe("0");
    expect(formatStroops(0n, { minDecimals: 4 })).toBe("0.0000");
  });

  it("formats fractional stroops accurately", () => {
    // 1 stroop = 0.0000001
    expect(formatStroops(1n)).toBe("0.0000001");
    // 10,000,000 stroops = 1 token
    expect(formatStroops(10_000_000n)).toBe("1.00");
    // 12,345,678 stroops
    expect(formatStroops(12_345_678n)).toBe("1.2345678");
    // 10,500,000 stroops = 1.05
    expect(formatStroops(10_500_000n)).toBe("1.05");
  });

  it("formats large values exceeding Number.MAX_SAFE_INTEGER without precision loss", () => {
    // Number.MAX_SAFE_INTEGER is 9007199254740991 (9e15).
    // Test with 10^24 stroops:
    const hugeAmount = 100_000_000_000_000_000_000_000_000n;
    const formatted = formatStroops(hugeAmount);
    expect(formatted).toBe("10,000,000,000,000,000,000.00");

    // Test with maximum i128 value: 2^127 - 1 = 170141183460469231731687303715884105727n
    const maxI128 = 170141183460469231731687303715884105727n;
    const formattedMax = formatStroops(maxI128);
    expect(formattedMax.startsWith("17,014,118,346,046,923,173,168,730,371.5884105727".slice(0, 30))).toBe(true);
    expect(formattedMax).toContain("17,014,118,346,046,923,173,168,730,371");
  });

  it("formats negative amounts", () => {
    expect(formatStroops(-10_000_000n)).toBe("-1.00");
    expect(formatStroops("-15000000")).toBe("-1.50");
  });
});

describe("parseStroops", () => {
  it("parses zero correctly", () => {
    expect(parseStroops("0")).toBe(0n);
    expect(parseStroops("0.0")).toBe(0n);
    expect(parseStroops("")).toBe(0n);
  });

  it("parses normal amounts without floating point errors", () => {
    expect(parseStroops("1")).toBe(10_000_000n);
    expect(parseStroops("1.05")).toBe(10_500_000n);
    expect(parseStroops("0.0000001")).toBe(1n);
    expect(parseStroops("12,345.67")).toBe(123_456_700_000n);
  });

  it("parses large amounts", () => {
    const parsed = parseStroops("1000000000000.1234567");
    expect(parsed).toBe(10000000000001234567n);
  });

  it("throws on invalid input", () => {
    expect(() => parseStroops("1.2.3")).toThrow();
    expect(() => parseStroops("abc")).toThrow();
  });
});

describe("truncateAddress", () => {
  it("truncates standard Stellar addresses", () => {
    const addr = "GBVOLK4B7YUGP645L73K6G223OIGT2M3QG77GQCYUXLWB266V266F53J";
    expect(truncateAddress(addr, 6, 4)).toBe("GBVOLK...F53J");
  });

  it("handles short or empty addresses safely", () => {
    expect(truncateAddress("")).toBe("None");
    expect(truncateAddress(undefined)).toBe("None");
    expect(truncateAddress(null)).toBe("None");
    expect(truncateAddress("SHORT")).toBe("SHORT");
  });
});

describe("relative and absolute time", () => {
  it("formats relative time correctly", () => {
    const now = 1700000000000;
    expect(formatRelativeTime(now, now)).toBe("just now");
    expect(formatRelativeTime(now - 120_000, now)).toBe("2m ago");
    expect(formatRelativeTime(now - 7_200_000, now)).toBe("2h ago");
    expect(formatRelativeTime(now - 86_400_000 * 3, now)).toBe("3d ago");
    expect(formatRelativeTime(now + 300_000, now)).toBe("in 5m");
  });

  it("formats absolute time in UTC", () => {
    // 1700000000 = 2023-11-14T22:13:20Z
    const formatted = formatAbsoluteTime(1700000000);
    expect(formatted).toContain("Nov 14, 2023");
    expect(formatted).toContain("UTC");
  });
});
