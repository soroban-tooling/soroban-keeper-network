import { useState, type FormEvent } from "react";
import { MIN_LOCK_LEDGERS, MIN_TTL_LEDGERS, TaskType } from "@soroban-keeper-network/sdk";
import { useRegisterTask } from "@soroban-keeper-network/sdk/react";

import { DEMO_KEYPAIR } from "../config.js";

/**
 * Registers a `TtlExtension` task (no calldata needed, unlike e.g.
 * `Liquidation`) via `useRegisterTask` (issue #241) — a minimal write-path
 * example alongside the two read hooks below.
 *
 * `owner` must match the client's configured signer (see `App.tsx`) or the
 * contract call fails its `require_auth`, so this demo's one signer is also
 * the one owner — a real app would take the connected wallet's own address
 * instead of importing a fixed keypair.
 */
export function RegisterTaskForm() {
  const { registerTask, status, error, reset } = useRegisterTask();
  const [reward, setReward] = useState("10000000"); // 1 XLM, in stroops
  const [lastTaskId, setLastTaskId] = useState<bigint>();

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    reset();
    try {
      const taskId = await registerTask({
        owner: DEMO_KEYPAIR.publicKey(),
        taskType: TaskType.TtlExtension,
        calldata: new Uint8Array(),
        reward: BigInt(reward),
        deadline: new Date(Date.now() + 24 * 60 * 60 * 1000), // 24h from now
        ttlLedgers: MIN_TTL_LEDGERS,
        lockLedgers: MIN_LOCK_LEDGERS,
      });
      setLastTaskId(taskId);
    } catch {
      // Surfaced below via `error` from the hook; nothing else to do here.
    }
  };

  return (
    <form onSubmit={handleSubmit}>
      <label>
        Reward (stroops):{" "}
        <input value={reward} onChange={(e) => setReward(e.target.value)} inputMode="numeric" />
      </label>{" "}
      <button type="submit" disabled={status === "pending"}>
        {status === "pending" ? "Registering…" : "Register task"}
      </button>
      {status === "success" && lastTaskId !== undefined ? (
        <p>Registered task #{String(lastTaskId)}.</p>
      ) : null}
      {status === "error" && error ? <p role="alert">Failed: {error.message}</p> : null}
    </form>
  );
}
