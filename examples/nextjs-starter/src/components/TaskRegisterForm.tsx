'use client';

import React, { useState } from 'react';
import { useRegisterTask } from '@soroban-keeper-network/sdk/react';

export interface TaskRegisterFormProps {
  ownerAddress?: string | null;
  onTaskRegistered?: (taskId: number) => void;
}

export function TaskRegisterForm({ ownerAddress, onTaskRegistered }: TaskRegisterFormProps) {
  const { registerTask, status, error, reset } = useRegisterTask();
  const [taskType, setTaskType] = useState<number>(0);
  const [calldata, setCalldata] = useState<string>('0xdeadbeef');
  const [rewardStroops, setRewardStroops] = useState<string>('1000000');
  const [deadlineLedgers, setDeadlineLedgers] = useState<number>(1000);
  const [lastRegisteredId, setLastRegisteredId] = useState<number | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ownerAddress) {
      alert('Please connect your Stellar wallet first.');
      return;
    }

    try {
      const now = Math.floor(Date.now() / 1000);
      const deadlineTimestamp = now + deadlineLedgers * 5; // ~5s per ledger

      const registeredId = await registerTask({
        owner: ownerAddress,
        taskType,
        calldata: Buffer.from(calldata.replace(/^0x/, ''), 'hex'),
        reward: BigInt(rewardStroops),
        deadline: deadlineTimestamp,
        ttlLedgers: 50000,
        lockLedgers: 120,
      } as any);

      const idNumber = Number(registeredId);
      setLastRegisteredId(idNumber);
      onTaskRegistered?.(idNumber);
    } catch (err) {
      console.error('Task registration failed:', err);
    }
  };

  return (
    <div className="bg-white p-6 rounded-lg shadow-md border border-gray-200">
      <h2 className="text-xl font-bold mb-4">Register New Automated Task</h2>

      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-gray-700">Task Type</label>
          <select
            value={taskType}
            onChange={(e) => setTaskType(Number(e.target.value))}
            className="mt-1 block w-full rounded-md border-gray-300 shadow-sm p-2 border"
          >
            <option value={0}>0 - Generic Execution</option>
            <option value={1}>1 - Oracle Update</option>
            <option value={2}>2 - Liquidation</option>
            <option value={3}>3 - Governance Execution</option>
            <option value={4}>4 - Recurring DCA</option>
          </select>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700">Calldata (Hex)</label>
          <input
            type="text"
            value={calldata}
            onChange={(e) => setCalldata(e.target.value)}
            className="mt-1 block w-full rounded-md border-gray-300 shadow-sm p-2 border font-mono text-sm"
          />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700">Reward (Stroops)</label>
            <input
              type="text"
              value={rewardStroops}
              onChange={(e) => setRewardStroops(e.target.value)}
              className="mt-1 block w-full rounded-md border-gray-300 shadow-sm p-2 border"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700">Deadline Offset (Ledgers)</label>
            <input
              type="number"
              value={deadlineLedgers}
              onChange={(e) => setDeadlineLedgers(Number(e.target.value))}
              className="mt-1 block w-full rounded-md border-gray-300 shadow-sm p-2 border"
            />
          </div>
        </div>

        <button
          type="submit"
          disabled={status === 'pending' || !ownerAddress}
          className="w-full py-2 px-4 bg-green-600 text-white font-semibold rounded-md hover:bg-green-700 disabled:opacity-50"
        >
          {status === 'pending' ? 'Registering on Stellar Testnet...' : 'Register Task'}
        </button>

        {status === 'success' && lastRegisteredId !== null && (
          <div className="p-3 bg-green-50 text-green-800 rounded border border-green-200 text-sm">
            ✓ Task #{lastRegisteredId} registered successfully!
          </div>
        )}

        {status === 'error' && error && (
          <div className="p-3 bg-red-50 text-red-800 rounded border border-red-200 text-sm">
            Error: {error.message}
          </div>
        )}
      </form>
    </div>
  );
}
