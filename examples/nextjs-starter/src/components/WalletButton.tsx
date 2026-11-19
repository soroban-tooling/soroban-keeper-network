'use client';

import React, { useState } from 'react';

export interface WalletButtonProps {
  onAddressChange?: (address: string | null) => void;
}

export function WalletButton({ onAddressChange }: WalletButtonProps) {
  const [address, setAddress] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);

  const handleConnect = async () => {
    setConnecting(true);
    try {
      // In production, integrate with Freighter / Stellar Wallets Kit:
      // const { isConnected, getAddress } = await import('@stellar/freighter-api');
      // Simulated wallet connection for starter demo:
      const mockTestnetAddress = 'GBZXN7PIRZGNMHGA728R4P445QJ6T2H6K5Z326G7QZPV4T6VODV4QYTEST';
      setAddress(mockTestnetAddress);
      onAddressChange?.(mockTestnetAddress);
    } finally {
      setConnecting(false);
    }
  };

  const handleDisconnect = () => {
    setAddress(null);
    onAddressChange?.(null);
  };

  if (address) {
    return (
      <div className="wallet-connected flex items-center gap-2">
        <span className="text-sm font-mono bg-gray-100 p-2 rounded">
          {address.slice(0, 6)}...{address.slice(-6)}
        </span>
        <button
          onClick={handleDisconnect}
          className="px-3 py-1 bg-red-600 text-white rounded text-sm hover:bg-red-700"
        >
          Disconnect
        </button>
      </div>
    );
  }

  return (
    <button
      onClick={handleConnect}
      disabled={connecting}
      className="px-4 py-2 bg-blue-600 text-white rounded font-medium hover:bg-blue-700 disabled:opacity-50"
    >
      {connecting ? 'Connecting...' : 'Connect Stellar Wallet'}
    </button>
  );
}
