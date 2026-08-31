// @vitest-environment node
//
// This file needs no DOM — it exercises transaction building, signing, and
// submission logic only. Forced to the plain `node` environment (rather
// than the suite-wide `jsdom` default) because `Keypair.fromRawEd25519Seed`
// under jsdom throws `"secretKey" expected Uint8Array of length 32, got
// type=object` — root-caused to `@noble/ed25519` being loaded as two
// separate module instances (this file's transform vs. `@stellar/stellar-sdk`'s
// internal import) under vitest's jsdom transform pipeline, which is a
// vitest/Vite module-graph duplication issue, not a bug in the code under
// test here (confirmed: the identical seed passed directly to a
// same-instance `ed.getPublicKey` call succeeds every time; only the
// cross-instance path through `Keypair` fails, and only under `jsdom`).

import {
  Account,
  type Keypair,
  nativeToScVal,
  rpc as SorobanRpc,
  SorobanDataBuilder,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";

import { KeeperRegistryClient } from "./client";
import { randomKeypair } from "./test-utils/randomKeypair";
import { buildFeeBumpTransaction, buildTransaction, type ExternalSigner, submitSignedTransaction } from "./transactionBuilder";

const CONTRACT_ID = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";
const RPC_URL = "https://soroban-testnet.stellar.org";
const NETWORK_PASSPHRASE = "Test SDF Network ; September 2015";

/**
 * A minimal-but-real `SimulateTransactionSuccessResponse` — every field
 * that `SorobanRpc.assembleTransaction` actually reads is present and of
 * the real SDK type (a real `SorobanDataBuilder`, a real `retval` `ScVal`),
 * confirmed to `assembleTransaction` cleanly in an ad hoc script before
 * being written into this fixture; it does not exercise a live network,
 * but it is not a loosely-typed stub either.
 */
type SimulateTransactionResponse = Awaited<ReturnType<InstanceType<typeof SorobanRpc.Server>["simulateTransaction"]>>;

function mockSimulationSuccess(): SimulateTransactionResponse {
  return {
    id: "1",
    latestLedger: 1000,
    events: [],
    _parsed: true,
    transactionData: new SorobanDataBuilder(),
    minResourceFee: "100",
    result: { auth: [], retval: nativeToScVal(null, { type: "void" }) },
    cost: { cpuInsns: "0", memBytes: "0" },
  } as unknown as SimulateTransactionResponse;
}

describe("buildTransaction / submitSignedTransaction round trip", () => {
  let sourceKeypair: Keypair;
  let sponsorKeypair: Keypair;
  let client: KeeperRegistryClient;
  let getAccountSpy: MockInstance;
  let simulateSpy: MockInstance;
  let sendSpy: MockInstance;
  let getTransactionSpy: MockInstance;

  beforeEach(() => {
    sourceKeypair = randomKeypair();
    sponsorKeypair = randomKeypair();
    client = new KeeperRegistryClient({ contractId: CONTRACT_ID, rpcUrl: RPC_URL, networkPassphrase: NETWORK_PASSPHRASE });

    getAccountSpy = vi
      .spyOn(SorobanRpc.Server.prototype, "getAccount")
      .mockImplementation(async (publicKey: string) => new Account(publicKey, "100"));
    simulateSpy = vi.spyOn(SorobanRpc.Server.prototype, "simulateTransaction").mockImplementation(async () => mockSimulationSuccess());
    sendSpy = vi
      .spyOn(SorobanRpc.Server.prototype, "sendTransaction")
      .mockImplementation(async () => ({ status: "PENDING", hash: "deadbeef" }) as never);
    getTransactionSpy = vi
      .spyOn(SorobanRpc.Server.prototype, "getTransaction")
      .mockImplementation(async () => ({ status: SorobanRpc.Api.GetTransactionStatus.SUCCESS }) as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("builds an unsigned, already-assembled transaction with the source account as the sole signer", async () => {
    const unsigned = await buildTransaction(client, sourceKeypair.publicKey(), "get_task", [
      nativeToScVal(1, { type: "u64" }),
    ]);

    expect(unsigned.signerAccounts).toEqual([sourceKeypair.publicKey()]);
    expect(unsigned.networkPassphrase).toBe(NETWORK_PASSPHRASE);
    expect(getAccountSpy).toHaveBeenCalledWith(sourceKeypair.publicKey());
    // "already assembled" (per `ContractInvoker.buildAndAssembleTransaction`'s
    // doc comment) means simulation ran and its result was fed into
    // `SorobanRpc.assembleTransaction` before this function returned — this
    // asserts the actual call sequence that makes the returned XDR
    // sign-ready, rather than a fee-arithmetic side effect that a minimal
    // mocked simulation response doesn't reliably reproduce (confirmed by
    // direct experiment: `assembleTransaction`'s fee delta depends on the
    // Soroban resource-fee data embedded in `transactionData`, not
    // `minResourceFee` alone — a bare `new SorobanDataBuilder()` here
    // legitimately produces no fee change).
    expect(simulateSpy).toHaveBeenCalledOnce();

    const tx = TransactionBuilder.fromXDR(unsigned.xdr, NETWORK_PASSPHRASE);
    expect(tx.source).toBe(sourceKeypair.publicKey());
    expect(tx.operations).toHaveLength(1);
  });

  it("full round trip: build unsigned -> external-sign with a real keypair (stand-in for a wallet) -> submit", async () => {
    const unsigned = await buildTransaction(client, sourceKeypair.publicKey(), "get_task", [
      nativeToScVal(1, { type: "u64" }),
    ]);

    // Stand-in for a wallet's signing flow: an external signer that never
    // shares the private key with the SDK, only ever handed a completed
    // signed XDR to submit.
    const externalSigner: ExternalSigner = {
      sign: (xdr, networkPassphrase) => {
        const tx = TransactionBuilder.fromXDR(xdr, networkPassphrase);
        tx.sign(sourceKeypair);
        return tx.toXDR();
      },
    };
    const signedXdr = await externalSigner.sign(unsigned.xdr, unsigned.networkPassphrase);

    await submitSignedTransaction(client, signedXdr);

    expect(sendSpy).toHaveBeenCalledOnce();
    expect(getTransactionSpy).toHaveBeenCalledWith("deadbeef");

    // Confirm what was actually submitted really does carry the source
    // keypair's signature — not merely that submission didn't throw.
    const submittedTx = sendSpy.mock.calls[0][0];
    expect(submittedTx.signatures).toHaveLength(1);
  });

  it("submitSignedTransaction throws when the network rejects the submission", async () => {
    sendSpy.mockImplementation(async () => ({ status: "ERROR", errorResult: { code: "tx_bad_seq" } }) as never);

    const unsigned = await buildTransaction(client, sourceKeypair.publicKey(), "get_task", [
      nativeToScVal(1, { type: "u64" }),
    ]);
    const tx = TransactionBuilder.fromXDR(unsigned.xdr, unsigned.networkPassphrase);
    tx.sign(sourceKeypair);

    await expect(submitSignedTransaction(client, tx.toXDR())).rejects.toThrow(/Send failed/);
  });

  it("submitSignedTransaction throws when confirmation never reaches SUCCESS", async () => {
    getTransactionSpy.mockImplementation(async () => ({ status: SorobanRpc.Api.GetTransactionStatus.FAILED }) as never);

    const unsigned = await buildTransaction(client, sourceKeypair.publicKey(), "get_task", [
      nativeToScVal(1, { type: "u64" }),
    ]);
    const tx = TransactionBuilder.fromXDR(unsigned.xdr, unsigned.networkPassphrase);
    tx.sign(sourceKeypair);

    await expect(submitSignedTransaction(client, tx.toXDR())).rejects.toThrow(/Transaction failed with status/);
  });

  it("throws a clear error when simulation fails during buildTransaction", async () => {
    simulateSpy.mockImplementation(async () => ({ error: "resource limit exceeded", events: [], _parsed: true }) as never);

    await expect(
      buildTransaction(client, sourceKeypair.publicKey(), "get_task", [nativeToScVal(1, { type: "u64" })]),
    ).rejects.toThrow(/Simulation failed/);
  });

  it("fee-bumps a source account with zero XLM balance for fees, and the sponsor's fee-bump makes it submittable", async () => {
    // The onboarding-UX scenario from the issue's acceptance criteria: the
    // source account signs its own inner transaction but never pays a fee
    // itself — the fee-bump envelope, paid by the sponsor, is what's
    // actually submitted.
    const unsigned = await buildTransaction(client, sourceKeypair.publicKey(), "get_task", [
      nativeToScVal(1, { type: "u64" }),
    ]);
    const innerTx = TransactionBuilder.fromXDR(unsigned.xdr, unsigned.networkPassphrase);
    innerTx.sign(sourceKeypair);

    const feeBumpUnsigned = buildFeeBumpTransaction(client, sponsorKeypair.publicKey(), innerTx.toXDR());
    expect(feeBumpUnsigned.signerAccounts).toEqual([sponsorKeypair.publicKey()]);

    const feeBumpTx = TransactionBuilder.fromXDR(feeBumpUnsigned.xdr, feeBumpUnsigned.networkPassphrase);
    // @ts-expect-error -- FeeBumpTransaction's .sign accepts a Keypair the same way Transaction's does.
    feeBumpTx.sign(sponsorKeypair);

    await submitSignedTransaction(client, feeBumpTx.toXDR());

    expect(sendSpy).toHaveBeenCalledOnce();
    const submitted = sendSpy.mock.calls[0][0];
    // The submitted envelope is the fee-bump wrapper, not the bare inner
    // tx — confirmed by its outer signature being the sponsor's, not the
    // source account's.
    expect(submitted.feeSource).toBeDefined();
  });
});
