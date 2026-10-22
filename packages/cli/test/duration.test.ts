import { describe, expect, it } from "vitest";

import { parseDeadline } from "../src/duration.js";
import { CliError } from "../src/errors.js";

const NOW = Date.UTC(2026, 0, 1, 12, 0, 0);

describe("parseDeadline", () => {
  it.each([
    ["+30s", 30],
    ["+90m", 90 * 60],
    ["+2h", 2 * 3_600],
    ["+1d", 86_400],
    ["+2w", 2 * 604_800],
    ["+1d12h", 86_400 + 12 * 3_600],
    ["+1h30m", 5_400],
  ])("reads the relative duration %s", (input, seconds) => {
    expect(parseDeadline(input, NOW).getTime()).toBe(NOW + seconds * 1_000);
  });

  it("reads an ISO timestamp with an offset", () => {
    expect(parseDeadline("2026-12-01T10:00:00Z", NOW).toISOString()).toBe("2026-12-01T10:00:00.000Z");
    expect(parseDeadline("2026-12-01T10:00:00+01:00", NOW).toISOString()).toBe(
      "2026-12-01T09:00:00.000Z",
    );
  });

  it("reads a bare date as midnight UTC", () => {
    expect(parseDeadline("2026-12-01", NOW).toISOString()).toBe("2026-12-01T00:00:00.000Z");
  });

  it("reads whole Unix seconds", () => {
    expect(parseDeadline("1798797600", NOW).getTime()).toBe(1_798_797_600_000);
  });

  it.each([
    "tomorrow",
    "+2x",
    "+h",
    "2h",
    "-2h",
    "+0s",
    "2026-12-01T10:00:00", // no zone: would silently depend on the machine's time zone
    "2026-13-45",
    "",
  ])("rejects %j as a usage error", (input) => {
    expect(() => parseDeadline(input, NOW)).toThrow(CliError);
    try {
      parseDeadline(input, NOW);
    } catch (error) {
      expect((error as CliError).exitCode).toBe(2);
    }
  });
});
