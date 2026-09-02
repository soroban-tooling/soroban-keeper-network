import { Keypair, Networks } from "@stellar/stellar-sdk";

import { KeeperRegistryClient, keypairSigner } from "../../src/client.js";
import type { KeeperRegistryClientOptions } from "../../src/client.js";
import { FakeRpc } from "./fakeRpc.js";
import type { FakeRpcOptions } from "./fakeRpc.js";

/** A valid, deterministic contract id for tests. */
export const CONTRACT_ID = "CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE";

export const OWNER_KEYPAIR = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 1));
export const OWNER = OWNER_KEYPAIR.publicKey();
export const KEEPER_KEYPAIR = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 2));
export const KEEPER = KEEPER_KEYPAIR.publicKey();
export const ADMIN_KEYPAIR = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 3));
export const ADMIN = ADMIN_KEYPAIR.publicKey();

/** Builds a client wired to a {@link FakeRpc}, returning both. */
export function testClient(
  rpcOptions: FakeRpcOptions = {},
  clientOptions: {
    [K in keyof KeeperRegistryClientOptions]?: KeeperRegistryClientOptions[K] | undefined;
  } = {},
): { client: KeeperRegistryClient; rpc: FakeRpc } {
  const rpc = new FakeRpc(rpcOptions);
  const client = new KeeperRegistryClient({
    signer: keypairSigner(OWNER_KEYPAIR),
    pollIntervalMs: 1,
    ...clientOptions,
    contractId: clientOptions.contractId ?? CONTRACT_ID,
    networkPassphrase: clientOptions.networkPassphrase ?? Networks.TESTNET,
    server: clientOptions.server ?? rpc,
  });
  return { client, rpc };
}
