import { describe, expect, it } from "vitest";
import { classifyError } from "./AsyncState";
import { IndexerRequestError } from "../data/indexer";

describe("AsyncState error classification", () => {
  it("formats IndexerRequestError with distinct indexer wording", () => {
    const indexerErr = new IndexerRequestError(503, "Service Unavailable");
    const classified = classifyError(indexerErr);

    expect(classified.source).toBe("indexer");
    expect(classified.title).toBe("Indexer Service Error");
    expect(classified.message).toContain("503");
    expect(classified.message).toContain("indexing service");
  });

  it("formats Stellar RPC / Soroban contract errors with distinct RPC wording", () => {
    const rpcErr = new Error("RPC error: simulation failed with code -32603");
    const classified = classifyError(rpcErr);

    expect(classified.source).toBe("rpc");
    expect(classified.title).toBe("Stellar RPC Error");
    expect(classified.message).toContain("Direct contract RPC call failed");
    expect(classified.message).toContain("Stellar RPC node");
  });

  it("respects explicit defaultSource parameter", () => {
    const genericErr = new Error("Network connection dropped");
    const rpcClassified = classifyError(genericErr, "rpc");
    expect(rpcClassified.source).toBe("rpc");
    expect(rpcClassified.title).toBe("Stellar RPC Error");

    const indexerClassified = classifyError(genericErr, "indexer");
    expect(indexerClassified.source).toBe("indexer");
    expect(indexerClassified.title).toBe("Indexer Service Error");
  });

  it("handles non-Error objects safely", () => {
    const stringErr = "timeout reading from horizon/soroban rpc";
    const classified = classifyError(stringErr);
    expect(classified.source).toBe("rpc");
  });
});
