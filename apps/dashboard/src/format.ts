/**
 * Shared formatting utilities for amounts, times, and addresses.
 * All amount arithmetic and conversions are performed strictly using `bigint`
 * and string manipulation, never converting through JavaScript `number`
 * to prevent IEEE 754 precision loss with large token or stroop amounts.
 */

export interface StroopFormatOptions {
  decimals?: number;
  minDecimals?: number;
  trimTrailingZeros?: boolean;
  addCommas?: boolean;
}

/**
 * Formats a raw integer amount in stroops (10^-7 by default) to human-readable token decimal string.
 * Strictly operates on bigint without ever converting to `number`.
 */
export function formatStroops(
  raw: bigint | string,
  options: StroopFormatOptions = {}
): string {
  const decimals = options.decimals ?? 7;
  const minDecimals = options.minDecimals ?? 2;
  const trimTrailingZeros = options.trimTrailingZeros ?? true;
  const addCommas = options.addCommas ?? true;

  const strRaw = typeof raw === "string" ? raw.trim() : raw.toString();
  if (strRaw === "" || strRaw === "0" || strRaw === "-0") {
    return minDecimals > 0 ? `0.${"0".repeat(minDecimals)}` : "0";
  }

  const bigVal = BigInt(strRaw);
  const isNegative = bigVal < 0n;
  const absVal = isNegative ? -bigVal : bigVal;
  const factor = 10n ** BigInt(decimals);

  const whole = absVal / factor;
  const fraction = absVal % factor;

  let wholeStr = whole.toString();
  if (addCommas) {
    wholeStr = wholeStr.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  }

  let fracStr = fraction.toString().padStart(decimals, "0");
  if (trimTrailingZeros) {
    fracStr = fracStr.replace(/0+$/, "");
  }
  if (fracStr.length < minDecimals) {
    fracStr = fracStr.padEnd(minDecimals, "0");
  }

  const sign = isNegative ? "-" : "";
  return fracStr.length > 0 ? `${sign}${wholeStr}.${fracStr}` : `${sign}${wholeStr}`;
}

/**
 * Parses user token input (e.g. "12.34567") into raw bigint stroops.
 * Does not use parseFloat or Number.
 */
export function parseStroops(input: string, decimals = 7): bigint {
  const clean = input.trim().replace(/,/g, "");
  if (!clean || clean === "0") return 0n;

  const isNegative = clean.startsWith("-");
  const unsigned = isNegative ? clean.slice(1) : clean;

  const parts = unsigned.split(".");
  if (parts.length > 2) {
    throw new Error(`Invalid decimal amount format: ${input}`);
  }

  const wholePart = parts[0] || "0";
  let fracPart = parts[1] || "";

  if (!/^\d*$/.test(wholePart) || !/^\d*$/.test(fracPart)) {
    throw new Error(`Invalid numeric characters in amount: ${input}`);
  }

  // Pad or slice fraction to target decimals
  if (fracPart.length > decimals) {
    fracPart = fracPart.slice(0, decimals);
  } else {
    fracPart = fracPart.padEnd(decimals, "0");
  }

  const wholeFactor = 10n ** BigInt(decimals);
  const wholeVal = BigInt(wholePart) * wholeFactor;
  const fracVal = BigInt(fracPart || "0");
  const total = wholeVal + fracVal;

  return isNegative ? -total : total;
}

/**
 * Truncates a Stellar public key or contract address with an ellipsis in the middle.
 */
export function truncateAddress(address?: string | null, start = 6, end = 4): string {
  if (!address) return "None";
  if (address.length <= start + end) return address;
  return `${address.slice(0, start)}...${address.slice(-end)}`;
}

/**
 * Formats an epoch timestamp (seconds or milliseconds) into a localized absolute date/time string.
 */
export function formatAbsoluteTime(
  timestamp: number | Date | string,
  options?: Intl.DateTimeFormatOptions
): string {
  const date = toDate(timestamp);
  if (isNaN(date.getTime())) return "Invalid date";

  const defaultOptions: Intl.DateTimeFormatOptions = {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZone: "UTC",
    timeZoneName: "short",
    ...options,
  };

  return date.toLocaleString("en-US", defaultOptions);
}

/**
 * Formats a timestamp into a relative human-friendly string (e.g. "5m ago", "in 2h").
 */
export function formatRelativeTime(
  timestamp: number | Date | string,
  baseTime?: number | Date
): string {
  const date = toDate(timestamp);
  if (isNaN(date.getTime())) return "Unknown";

  const now = baseTime ? toDate(baseTime).getTime() : Date.now();
  const diffMs = now - date.getTime();
  const diffSec = Math.floor(diffMs / 1000);

  if (Math.abs(diffSec) < 5) return "just now";

  if (diffSec > 0) {
    if (diffSec < 60) return `${diffSec}s ago`;
    const min = Math.floor(diffSec / 60);
    if (min < 60) return `${min}m ago`;
    const hrs = Math.floor(min / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    if (days < 30) return `${days}d ago`;
    const months = Math.floor(days / 30);
    if (months < 12) return `${months}mo ago`;
    return `${Math.floor(days / 365)}y ago`;
  } else {
    const futureSec = -diffSec;
    if (futureSec < 60) return `in ${futureSec}s`;
    const min = Math.floor(futureSec / 60);
    if (min < 60) return `in ${min}m`;
    const hrs = Math.floor(min / 60);
    if (hrs < 24) return `in ${hrs}h`;
    const days = Math.floor(hrs / 24);
    return `in ${days}d`;
  }
}

function toDate(val: number | Date | string): Date {
  if (val instanceof Date) return val;
  if (typeof val === "string") {
    if (/^\d+$/.test(val)) {
      const num = Number(val);
      return new Date(num < 1e11 ? num * 1000 : num);
    }
    return new Date(val);
  }
  return new Date(val < 1e11 ? val * 1000 : val);
}
