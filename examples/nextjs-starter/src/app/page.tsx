'use client';

import React, { useState } from 'react';
import { WalletButton } from '../components/WalletButton.tsx';
import { TaskRegisterForm } from '../components/TaskRegisterForm.tsx';
import { TaskTracker } from '../components/TaskTracker.tsx';

export default function Home() {
  const [walletAddress, setWalletAddress] = useState<string | null>(null);
  const [activeTaskId, setActiveTaskId] = useState<number>(1);

  return (
    <main className="max-w-4xl mx-auto py-10 px-4 space-y-8">
      <header className="flex justify-between items-center border-b pb-6">
        <div>
          <h1 className="text-3xl font-extrabold tracking-tight">
            Soroban Keeper Network
          </h1>
          <p className="text-gray-500 text-sm mt-1">
            Next.js Starter dApp — Register and track automated tasks via React hooks
          </p>
        </div>
        <WalletButton onAddressChange={setWalletAddress} />
      </header>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
        <section>
          <TaskRegisterForm
            ownerAddress={walletAddress}
            onTaskRegistered={(id) => setActiveTaskId(id)}
          />
        </section>

        <section>
          <TaskTracker initialTaskId={activeTaskId} />
        </section>
      </div>

      <footer className="text-center text-xs text-gray-400 pt-8 border-t">
        Powered by @soroban-keeper-network/sdk • Connected to Stellar Testnet
      </footer>
    </main>
  );
}
