'use client';

import React, { useState } from 'react';
import { useTask, useTaskEvents } from '@soroban-keeper-network/sdk/react';

export interface TaskTrackerProps {
  initialTaskId?: number;
}

export function TaskTracker({ initialTaskId = 1 }: TaskTrackerProps) {
  const [selectedId, setSelectedId] = useState<number>(initialTaskId);
  const [inputVal, setInputVal] = useState<string>(initialTaskId.toString());

  const { task, loading, error, refetch } = useTask(selectedId, {
    pollIntervalMs: 3000,
  });

  const { events, loading: eventsLoading } = useTaskEvents(selectedId, {
    pollIntervalMs: 3000,
  });

  const handleLookup = (e: React.FormEvent) => {
    e.preventDefault();
    const parsed = parseInt(inputVal, 10);
    if (!isNaN(parsed) && parsed > 0) {
      setSelectedId(parsed);
    }
  };

  const statusColors: Record<string, string> = {
    Pending: 'bg-yellow-100 text-yellow-800 border-yellow-300',
    Claimed: 'bg-blue-100 text-blue-800 border-blue-300',
    Executed: 'bg-green-100 text-green-800 border-green-300',
    Cancelled: 'bg-gray-100 text-gray-800 border-gray-300',
    Expired: 'bg-red-100 text-red-800 border-red-300',
  };

  return (
    <div className="bg-white p-6 rounded-lg shadow-md border border-gray-200">
      <div className="flex justify-between items-center mb-4">
        <h2 className="text-xl font-bold">Live Task Status & Events</h2>
        <form onSubmit={handleLookup} className="flex gap-2">
          <input
            type="number"
            min={1}
            value={inputVal}
            onChange={(e) => setInputVal(e.target.value)}
            className="w-24 p-1 border rounded text-sm font-mono"
            placeholder="Task #"
          />
          <button
            type="submit"
            className="px-3 py-1 bg-gray-800 text-white rounded text-sm hover:bg-gray-700"
          >
            Track
          </button>
        </form>
      </div>

      {loading && !task && (
        <div className="p-4 text-center text-gray-500 animate-pulse">
          Polling task #{selectedId} on-chain state...
        </div>
      )}

      {error && (
        <div className="p-4 bg-red-50 text-red-700 rounded border border-red-200 text-sm">
          {error.message || `Task #${selectedId} not found or RPC unreachable`}
        </div>
      )}

      {task && (
        <div className="space-y-4">
          <div className="flex items-center justify-between p-3 bg-gray-50 rounded">
            <div>
              <span className="text-xs text-gray-500 block">Status</span>
              <span
                className={`inline-block px-2 py-0.5 text-xs font-semibold rounded border ${
                  statusColors[task.status] || 'bg-gray-100'
                }`}
              >
                {task.status}
              </span>
            </div>

            <div>
              <span className="text-xs text-gray-500 block">Reward</span>
              <span className="text-sm font-mono font-medium">
                {task.reward ? task.reward.toString() : '0'} stroops
              </span>
            </div>

            <div>
              <span className="text-xs text-gray-500 block">Deadline</span>
              <span className="text-sm font-mono">{task.deadline || 'N/A'}</span>
            </div>

            <button
              onClick={() => refetch()}
              className="text-xs text-blue-600 hover:underline"
            >
              Refresh
            </button>
          </div>

          <div>
            <h3 className="text-sm font-semibold text-gray-700 mb-2">Live On-Chain Events</h3>
            {eventsLoading && events.length === 0 ? (
              <div className="text-xs text-gray-400">Loading events...</div>
            ) : events.length === 0 ? (
              <div className="text-xs text-gray-400 italic">No events emitted yet for task #{selectedId}</div>
            ) : (
              <ul className="divide-y divide-gray-100 text-xs font-mono">
                {events.map((evt: any, idx: number) => (
                  <li key={idx} className="py-2 flex justify-between">
                    <span className="font-semibold text-gray-800">{evt.type || 'Event'}</span>
                    <span className="text-gray-500">{evt.timestamp || 'Just now'}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
