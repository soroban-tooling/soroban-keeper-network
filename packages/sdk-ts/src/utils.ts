import { StrKey, nativeToScVal, scValToNative, xdr } from "@stellar/stellar-sdk";

/**
 * Validates a Soroban contract ID string (C...).
 */
export function validateContractId(contractId: string): void {
  if (!contractId || typeof contractId !== "string" || !StrKey.isValidContract(contractId)) {
    throw new Error(`Invalid contract ID: "${contractId}". Must be a valid C... address.`);
  }
}

/**
 * Validates a Stellar account public key or contract address (G... or C...).
 */
export function validateAddress(address: string, label = "address"): void {
  if (!address || typeof address !== "string") {
    throw new Error(`Invalid ${label}: address must be a non-empty string.`);
  }
  const isAccount = StrKey.isValidEd25519PublicKey(address);
  const isContract = StrKey.isValidContract(address);
  if (!isAccount && !isContract) {
    throw new Error(`Invalid ${label}: "${address}". Must be a valid Stellar public key (G...) or contract ID (C...).`);
  }
}

/**
 * Validates a Stellar secret key (S...).
 */
export function validateSecretKey(secretKey: string): void {
  if (!secretKey || typeof secretKey !== "string" || !StrKey.isValidEd25519SecretSeed(secretKey)) {
    throw new Error(`Invalid secret key. Must be a valid S... seed.`);
  }
}

/**
 * Converts a byte array, Buffer, or hex string into a Buffer.
 */
export function toBuffer(val: Buffer | Uint8Array | string): Buffer {
  if (Buffer.isBuffer(val)) {
    return val;
  }
  if (val instanceof Uint8Array) {
    return Buffer.from(val);
  }
  if (typeof val === "string") {
    if (val.startsWith("0x")) {
      return Buffer.from(val.slice(2), "hex");
    }
    // Check if valid hex
    if (/^[0-9a-fA-F]*$/.test(val) && val.length % 2 === 0) {
      return Buffer.from(val, "hex");
    }
    return Buffer.from(val, "utf-8");
  }
  throw new Error(`Cannot convert value of type ${typeof val} to Buffer.`);
}

/**
 * Encodes JavaScript types into Soroban ScVals for contract call arguments.
 */
export function encodeScVal(val: any, type: string): xdr.ScVal {
  switch (type) {
    case "address":
      validateAddress(val);
      return nativeToScVal(val, { type: "address" });
    case "u32":
      return nativeToScVal(Number(val), { type: "u32" });
    case "u64":
      return nativeToScVal(BigInt(val), { type: "u64" });
    case "i128":
      return nativeToScVal(BigInt(val), { type: "i128" });
    case "bytes":
      return nativeToScVal(toBuffer(val), { type: "bytes" });
    case "bytes32": {
      const buf = toBuffer(val);
      if (buf.length !== 32) {
        throw new Error(`Invalid BytesN<32> length: expected 32 bytes, got ${buf.length}.`);
      }
      return nativeToScVal(buf, { type: "bytes" });
    }
    case "opt_address":
      if (val === undefined || val === null) {
        return nativeToScVal(null);
      }
      validateAddress(val);
      return nativeToScVal(val, { type: "address" });
    default:
      return nativeToScVal(val);
  }
}

export { scValToNative };
