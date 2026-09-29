import { useState } from "react";
import { useKeeperRegistryClient, useKeeperBalance } from "@soroban-keeper-network/sdk/react";

export interface KeeperBalanceWidgetProps {
  address: string;
}

/**
 * Displays a keeper's accrued balance via `useKeeperBalance` (issue #243),
 * with a withdraw button. There is no `useWithdrawRewards` hook (only
 * `useTask`, `useTaskEvents`, `useRegisterTask`, and `useKeeperBalance` are
 * built so far) — this calls the client's plain `tryWithdrawRewards` method
 * directly via `useKeeperRegistryClient()`, the same seam every hook itself
 * is built on, and `refetch()`s the balance on success. A one-off imperative
 * action like this doesn't need its own hook to be usable from a component.
 */
export function KeeperBalanceWidget({ address }: KeeperBalanceWidgetProps) {
  const client = useKeeperRegistryClient();
  const { balance, loading, error, refetch } = useKeeperBalance(address, { pollIntervalMs: 10_000 });
  const [withdrawing, setWithdrawing] = useState(false);
  const [withdrawError, setWithdrawError] = useState<Error>();

  const handleWithdraw = async () => {
    setWithdrawing(true);
    setWithdrawError(undefined);
    try {
      await client.tryWithdrawRewards({ keeper: address });
      await refetch();
    } catch (cause) {
      setWithdrawError(cause instanceof Error ? cause : new Error(String(cause)));
    } finally {
      setWithdrawing(false);
    }
  };

  return (
    <div>
      {loading ? <p>Loading balance…</p> : <p>Balance: {balance.toString()} stroops</p>}
      {error ? <p role="alert">Failed to load balance: {error.message}</p> : null}
      <button type="button" onClick={handleWithdraw} disabled={withdrawing || balance === 0n}>
        {withdrawing ? "Withdrawing…" : "Withdraw"}
      </button>
      {withdrawError ? <p role="alert">Withdraw failed: {withdrawError.message}</p> : null}
    </div>
  );
}
