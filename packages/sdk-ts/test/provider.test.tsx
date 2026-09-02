import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToString } from "react-dom/server";
import { Networks } from "@stellar/stellar-sdk";
import { KeeperRegistryClient } from "../src/client";
import { KeeperRegistryProvider, useKeeperRegistryClient } from "../src/react/provider";

const dummyContractId = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";
const networkPassphrase = Networks.TESTNET;
const rpcUrl = "https://soroban-testnet.stellar.org";

test("useKeeperRegistryClient throws a clear actionable error when used outside KeeperRegistryProvider", () => {
  function OutOfBoundsComponent() {
    useKeeperRegistryClient();
    return null;
  }

  assert.throws(
    () => {
      renderToString(<OutOfBoundsComponent />);
    },
    (err: any) => {
      return (
        err instanceof Error &&
        err.message.includes("useKeeperRegistryClient must be used within a <KeeperRegistryProvider>.")
      );
    }
  );
});

test("KeeperRegistryProvider provides client instance to context consumers", () => {
  const customClient = new KeeperRegistryClient({
    contractId: dummyContractId,
    rpcUrl,
    networkPassphrase,
  });

  let capturedClient: KeeperRegistryClient | null = null;

  function ConsumerComponent() {
    const client = useKeeperRegistryClient();
    capturedClient = client;
    return <div>{client.contractId}</div>;
  }

  const html = renderToString(
    <KeeperRegistryProvider client={customClient}>
      <ConsumerComponent />
    </KeeperRegistryProvider>
  );

  assert.ok(html.includes(dummyContractId));
  assert.equal(capturedClient, customClient);
});

test("KeeperRegistryProvider constructs client automatically from config props", () => {
  let capturedClient: KeeperRegistryClient | null = null;

  function ConsumerComponent() {
    const client = useKeeperRegistryClient();
    capturedClient = client;
    return <div>{client.contractId}</div>;
  }

  const html = renderToString(
    <KeeperRegistryProvider
      contractId={dummyContractId}
      rpcUrl={rpcUrl}
      networkPassphrase={networkPassphrase}
    >
      <ConsumerComponent />
    </KeeperRegistryProvider>
  );

  assert.ok(html.includes(dummyContractId));
  assert.ok(capturedClient !== null);
  assert.equal((capturedClient as KeeperRegistryClient).contractId, dummyContractId);
  assert.equal((capturedClient as KeeperRegistryClient).rpcUrl, rpcUrl);
});

test("KeeperRegistryProvider throws error if required config props are missing when client is not passed", () => {
  function ConsumerComponent() {
    useKeeperRegistryClient();
    return null;
  }

  assert.throws(
    () => {
      renderToString(
        // @ts-ignore
        <KeeperRegistryProvider contractId={dummyContractId}>
          <ConsumerComponent />
        </KeeperRegistryProvider>
      );
    },
    /KeeperRegistryProvider requires either a `client` prop or all of/
  );
});
