/**
 * Test helpers for encoding oracle conditions into calldata
 *
 * Used by tests to create realistic oracle condition task calldata
 * without depending on the full SDK helpers (which are still being developed
 * as part of issue #0424).
 *
 * These are minimal implementations for testing purposes.
 */

import type { OraclePriceThresholdCondition } from "../../src/conditions.js";

/**
 * Encode an oracle price-threshold condition into test calldata.
 *
 * This is a simplified encoding for testing. The actual encoding follows
 * the keeper-registry contract's format, which will be standardized in
 * SDK helpers (issue #0424).
 *
 * Format (simplified):
 * - 1 byte: condition type (0x01 for oracle price-threshold)
 * - Variable: feed ID string (base asset, separator, quote asset)
 * - Variable: threshold value (big-endian int128)
 * - 1 byte: direction (0x00 for above, 0x01 for below)
 *
 * @param condition The oracle condition to encode
 * @returns Buffer representing the encoded condition
 */
export function encodeOraclePriceThresholdCondition(
  condition: OraclePriceThresholdCondition
): Buffer {
  const buffers: Buffer[] = [];

  // Type marker: 0x01 = oracle price-threshold
  buffers.push(Buffer.from([0x01]));

  // Feed ID: "base/quote"
  const feedIdStr = `${condition.feedId.base}/${condition.feedId.quote}`;
  const feedIdBytes = Buffer.from(feedIdStr, "utf-8");
  // Length prefix (1 byte for simplicity; real SDK would use varint)
  buffers.push(Buffer.from([feedIdBytes.length]));
  buffers.push(feedIdBytes);

  // Threshold: big-endian int128 (16 bytes)
  const thresholdBuf = Buffer.alloc(16);
  thresholdBuf.writeBigInt64BE(condition.threshold, 8); // Simplified: store in upper 64 bits
  buffers.push(thresholdBuf);

  // Direction: 0x00 = above, 0x01 = below
  const directionByte = condition.direction === "above" ? 0x00 : 0x01;
  buffers.push(Buffer.from([directionByte]));

  // Decimals: 1 byte (simplified; real encoding would be more flexible)
  buffers.push(Buffer.from([condition.decimals]));

  return Buffer.concat(buffers);
}

/**
 * Decode an oracle price-threshold condition from test calldata.
 *
 * Inverse of encodeOraclePriceThresholdCondition.
 *
 * @param calldata Encoded condition bytes
 * @returns Decoded condition, or undefined if decoding fails
 */
export function decodeOraclePriceThresholdConditionTest(
  calldata: Buffer
): OraclePriceThresholdCondition | undefined {
  if (calldata.length < 2) {
    return undefined;
  }

  let offset = 0;

  // Type marker
  const typeMarker = calldata[offset];
  offset += 1;
  if (typeMarker !== 0x01) {
    return undefined; // Not an oracle price-threshold condition
  }

  // Feed ID length
  const feedIdLen = calldata[offset];
  offset += 1;
  if (offset + feedIdLen > calldata.length) {
    return undefined;
  }

  // Feed ID string
  const feedIdStr = calldata.toString("utf-8", offset, offset + feedIdLen);
  offset += feedIdLen;

  const feedParts = feedIdStr.split("/");
  if (feedParts.length !== 2) {
    return undefined;
  }

  // Threshold (16 bytes)
  if (offset + 16 > calldata.length) {
    return undefined;
  }
  const threshold = calldata.readBigInt64BE(offset + 8); // Simplified: read from upper 64 bits
  offset += 16;

  // Direction
  if (offset + 1 > calldata.length) {
    return undefined;
  }
  const directionByte = calldata[offset];
  offset += 1;
  const direction = directionByte === 0x00 ? "above" : "below";

  // Decimals
  if (offset + 1 > calldata.length) {
    return undefined;
  }
  const decimals = calldata[offset];

  return {
    feedId: {
      base: feedParts[0],
      quote: feedParts[1],
    },
    threshold,
    direction,
    decimals,
  };
}
