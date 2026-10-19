import { describe, expect, it } from "vitest";
import { formatRemaining, formatTokenUnits, parseStatus } from "../src/commands/task/format.js";
import { parseDeadline } from "../src/commands/task/deadline.js";
import { UsageError } from "../src/args.js";

describe("token units", () => {
  it("converts stroops to seven-decimal token units and trims trailing zeros", () => {
    expect(formatTokenUnits(10_000_000n)).toBe("1.0");
    expect(formatTokenUnits(5_000_000n)).toBe("0.5");
    expect(formatTokenUnits(1n)).toBe("0.0000001");
    expect(formatTokenUnits(12_345_678n)).toBe("1.2345678");
    expect(formatTokenUnits(0n)).toBe("0.0");
  });
});

describe("remaining time", () => {
  const now = 1_000_000;

  it("picks the largest sensible unit", () => {
    expect(formatRemaining(now + 2 * 86_400 + 3 * 3_600, now)).toBe("2d 3h");
    expect(formatRemaining(now + 2 * 3_600 + 5 * 60, now)).toBe("2h 5m");
    expect(formatRemaining(now + 5 * 60, now)).toBe("5m");
    expect(formatRemaining(now + 30, now)).toBe("30s");
  });

  it("says passed once the deadline is over", () => {
    expect(formatRemaining(now - 1, now)).toBe("passed");
    expect(formatRemaining(now, now)).toBe("passed");
  });
});

describe("status filter", () => {
  it("accepts a name in any case or the contract number", () => {
    expect(parseStatus("Pending")).toBe(0);
    expect(parseStatus("expired")).toBe(4);
    expect(parseStatus("2")).toBe(2);
  });

  it("returns undefined for an unknown value", () => {
    expect(parseStatus("sleeping")).toBeUndefined();
  });
});

describe("deadlines (#695)", () => {
  const now = 1_700_000_000;

  it("adds a relative duration to now", () => {
    expect(parseDeadline("+90s", now)).toBe(now + 90);
    expect(parseDeadline("+30m", now)).toBe(now + 1_800);
    expect(parseDeadline("+2h", now)).toBe(now + 7_200);
    expect(parseDeadline("+7d", now)).toBe(now + 604_800);
  });

  it("accepts an ISO timestamp as Unix seconds", () => {
    expect(parseDeadline("2030-01-01T00:00:00Z", now)).toBe(1_893_456_000);
    expect(parseDeadline("2030-01-01", now)).toBe(1_893_456_000);
  });

  it("rejects anything else as a usage error", () => {
    expect(() => parseDeadline("tomorrow", now)).toThrow(UsageError);
    expect(() => parseDeadline("+2w", now)).toThrow(UsageError);
    expect(() => parseDeadline("", now)).toThrow(UsageError);
  });
});
