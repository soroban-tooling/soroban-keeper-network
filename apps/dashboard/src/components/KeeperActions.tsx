import { Coins, Landmark, LockKeyhole, WalletCards } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useDashboardData } from "../data/context";

export function KeeperActions({ keeper, balance, unbond }: { keeper: string; balance: bigint; unbond?: { amount: bigint; unlockLedger: number } }) {
  const { operations, account } = useDashboardData();
  const [amount, setAmount] = useState("");
  const [ledger, setLedger] = useState<number | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const ownProfile = account === keeper;
  useEffect(() => { if (operations) void operations.latestLedger().then(setLedger).catch(() => setLedger(null)); }, [operations]);
  const run = useCallback(async (label: string, action: () => Promise<unknown>) => { setBusy(label); setMessage(null); try { await action(); setMessage(`${label} submitted successfully.`); } catch (cause) { setMessage(cause instanceof Error ? cause.message : `${label} failed`); } finally { setBusy(null); } }, []);
  const parsed = /^\d+$/.test(amount) ? BigInt(amount) : 0n;
  const unavailable = !operations ? "Connect a supported wallet to transact." : !ownProfile ? "Actions are available only on your own keeper profile." : undefined;
  const canWithdrawStake = Boolean(unbond && ledger !== null && ledger >= unbond.unlockLedger);

  return <section className="action-panel" aria-labelledby="keeper-actions-title"><div className="section-heading"><h2 id="keeper-actions-title">Keeper actions</h2>{unavailable && <span>{unavailable}</span>}</div>
    <div className="action-row"><label>Amount<input inputMode="numeric" value={amount} onChange={(event) => setAmount(event.target.value)} placeholder="Token units" /></label>
      <button disabled={Boolean(unavailable) || parsed <= 0n || busy !== null} onClick={() => void run("Stake", () => operations!.stake(keeper, parsed))}><Landmark />Stake</button>
      <button disabled={Boolean(unavailable) || parsed <= 0n || busy !== null || Boolean(unbond)} onClick={() => void run("Unbond", () => operations!.unbond(keeper, parsed))}><LockKeyhole />Unbond</button>
      <button disabled={Boolean(unavailable) || !canWithdrawStake || busy !== null} title={unbond && !canWithdrawStake ? `Unlocks at ledger ${unbond.unlockLedger}` : undefined} onClick={() => void run("Withdraw stake", () => operations!.withdrawStake(keeper))}><WalletCards />Withdraw stake</button>
      <button disabled={Boolean(unavailable) || balance === 0n || busy !== null} title={balance === 0n ? "No rewards are available" : undefined} onClick={() => void run("Withdraw rewards", () => operations!.withdrawRewards(keeper))}><Coins />Withdraw rewards</button>
    </div>
    {unbond && <p className="form-note">Pending unbond: {unbond.amount.toLocaleString()} {canWithdrawStake ? "is withdrawable now" : `unlocks at ledger ${unbond.unlockLedger.toLocaleString()}`}.</p>}
    {message && <p className="form-message" role="status">{message}</p>}
  </section>;
}
