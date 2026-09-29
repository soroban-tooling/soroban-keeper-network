import { useMemo, useState } from "react";
import { KeeperRegistryClient, keypairSigner } from "@soroban-keeper-network/sdk";
import { KeeperRegistryProvider } from "@soroban-keeper-network/sdk/react";

import { KeeperBalanceWidget } from "./components/KeeperBalanceWidget.js";
import { RegisterTaskForm } from "./components/RegisterTaskForm.js";
import { TaskList } from "./components/TaskList.js";
import { DEMO_KEYPAIR, NETWORK, NETWORK_NAME, REGISTRY_CONTRACT_ID } from "./config.js";

/**
 * Wires up one `KeeperRegistryClient` for the whole app and provides it via
 * `KeeperRegistryProvider` (backlog 0173) — every hook below reads this same
 * instance through `useKeeperRegistryClient()` rather than each constructing
 * its own.
 */
export function App() {
  const [balanceAddress, setBalanceAddress] = useState(DEMO_KEYPAIR.publicKey());

  const client = useMemo(
    () =>
      new KeeperRegistryClient({
        contractId: REGISTRY_CONTRACT_ID,
        rpcUrl: NETWORK.rpcUrl,
        networkPassphrase: NETWORK.networkPassphrase,
        signer: keypairSigner(DEMO_KEYPAIR),
      }),
    [],
  );

  return (
    <KeeperRegistryProvider client={client}>
      <main style={{ maxWidth: 720, margin: "2rem auto", fontFamily: "sans-serif" }}>
        <h1>Keeper Network SDK — React hooks example</h1>
        <p>
          Network: <code>{NETWORK_NAME}</code> · Registry: <code>{REGISTRY_CONTRACT_ID}</code>
        </p>

        <section>
          <h2>Keeper balance</h2>
          <label>
            Keeper address:{" "}
            <input
              value={balanceAddress}
              onChange={(e) => setBalanceAddress(e.target.value)}
              size={56}
            />
          </label>
          <KeeperBalanceWidget address={balanceAddress} />
        </section>

        <section>
          <h2>Register a task</h2>
          <RegisterTaskForm />
        </section>

        <section>
          <h2>Live task activity</h2>
          <TaskList />
        </section>
      </main>
    </KeeperRegistryProvider>
  );
}
