import { usageError } from "./errors.js";

const UNIT_SECONDS: Readonly<Record<string, number>> = {
  s: 1,
  m: 60,
  h: 3_600,
  d: 86_400,
  w: 604_800,
};

/**
 * Parses a deadline given as one of:
 *
 * - a relative duration, `+2h`, `+90m`, `+1d12h` (units `s m h d w`),
 * - an ISO-8601 timestamp with an explicit offset, `2026-12-01T10:00:00Z`,
 * - an ISO date, `2026-12-01` (midnight UTC),
 * - whole Unix seconds, `1798797600`.
 *
 * A timestamp without an offset is refused rather than read in the local zone:
 * a deadline that silently shifts by the machine's time zone is worse than an
 * error.
 */
export function parseDeadline(input: string, nowMs: number): Date {
  const text = input.trim();

  const relative = /^\+((?:\d+[smhdw])+)$/.exec(text);
  if (relative) {
    let seconds = 0;
    for (const part of (relative[1] ?? "").matchAll(/(\d+)([smhdw])/g)) {
      seconds += Number(part[1]) * (UNIT_SECONDS[part[2] ?? ""] ?? 0);
    }
    if (seconds <= 0) {
      throw usageError(`Deadline "${input}" is a zero-length duration.`);
    }
    return new Date(nowMs + seconds * 1_000);
  }

  if (/^\d+$/.test(text)) {
    return new Date(Number(text) * 1_000);
  }

  const isDate = /^\d{4}-\d{2}-\d{2}$/.test(text);
  const isDateTime = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/i.test(
    text,
  );
  if (isDate || isDateTime) {
    const parsed = new Date(text);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }

  throw usageError(
    `Could not read deadline "${input}". Use a duration such as +2h, an ISO timestamp with ` +
      `a timezone such as 2026-12-01T10:00:00Z, or Unix seconds.`,
  );
}
