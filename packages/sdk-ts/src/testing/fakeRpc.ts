import {
  nativeToScVal,
  scValToNative,
} from "@stellar/stellar-sdk";

export interface FakeRpcOptions {
  healthLedger?: number;
}

export class FakeRpcServer {
  private readonly healthLedger: number;

  private responses = new Map<string, unknown>();

  constructor(options: FakeRpcOptions = {}) {
    this.healthLedger = options.healthLedger ?? 100;
  }

  setResponse(method: string, value: unknown): void {
    this.responses.set(method, value);
  }

  async getHealth() {
    return {
      status: "healthy",
      latestLedger: this.healthLedger,
    };
  }

  async simulateTransaction() {
    const value = this.responses.get("simulateTransaction");

    return {
      results: [
        {
          xdr: nativeToScVal(value).toXDR(),
        },
      ],
      result: value === undefined
        ? undefined
        : {
            retval: nativeToScVal(value),
          },
    };
  }

  async sendTransaction() {
    const value = this.responses.get("sendTransaction");

    return {
      status: "PENDING",
      hash:
        typeof value === "string"
          ? value
          : "fake-transaction-hash",
    };
  }

  async getTransaction(hash: string) {
    const value = this.responses.get(
      `getTransaction:${hash}`,
    );

    return {
      status: "SUCCESS",
      hash,
      result:
        value === undefined
          ? undefined
          : nativeToScVal(value),
    };
  }

  async getAccount(address: string) {
    return {
      id: address,
      sequence: "1",
    };
  }

  async getEvents() {
    const events = this.responses.get("getEvents");

    return {
      events: Array.isArray(events) ? events : [],
    };
  }

  encodeValue(value: unknown) {
    return nativeToScVal(value);
  }

  decodeValue(value: ReturnType<typeof nativeToScVal>) {
    return scValToNative(value);
  }
}

/*
 * IMPORTANT:
 *
 * Do not replace nativeToScVal/scValToNative with hand-written fake
 * response objects. This fake exists specifically to keep SDK tests
 * coupled to the real Stellar SDK XDR encoding/decoding behavior.
 *
 * A sibling keeper-bot test suite previously used assumed RPC response
 * shapes (wave-2 bot test PR #128). Keep this fake different: responses
 * must survive a real Stellar SDK encode/decode round trip.
 */
