'use client';

import React, { useMemo } from 'react';
import { KeeperRegistryProvider } from '@soroban-keeper-network/sdk/react';
import { KeeperRegistryClient } from '@soroban-keeper-network/sdk';

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const client = useMemo(() => {
    const contractId =
      process.env.NEXT_PUBLIC_KEEPER_REGISTRY_ADDRESS ||
      'CA3D5KRYMCMCZWPT2PBN6CKP3F73S6XQPO2U2R44K64W74UBWLDN7426';
    const rpcUrl =
      process.env.NEXT_PUBLIC_STELLAR_RPC_URL ||
      'https://soroban-testnet.stellar.org';
    const networkPassphrase =
      process.env.NEXT_PUBLIC_NETWORK_PASSPHRASE ||
      'Test SDF Network ; September 2015';

    return new KeeperRegistryClient({
      contractId,
      rpcUrl,
      networkPassphrase,
    } as any);
  }, []);

  return (
    <html lang="en">
      <body className="bg-gray-100 min-h-screen text-gray-900 antialiased">
        <KeeperRegistryProvider client={client}>
          {children}
        </KeeperRegistryProvider>
      </body>
    </html>
  );
}
