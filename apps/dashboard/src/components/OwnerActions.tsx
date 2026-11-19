import { Ban, CalendarClock, CircleDollarSign } from "lucide-react";
import { useMemo, useState } from "react";
import { useDashboardData } from "../data/context";
import type { TaskState } from "../data/types";

export function OwnerActions({ task }: { task: TaskState }) {
  const { account, operations } = useDashboardData();
  const [reward, setReward] = useState("");
  const [deadline, setDeadline] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const isOwner = account === task.owner;
  const canEdit = task.status === "pending";
  const canCancel = task.status === "pending" || task.status === "claimed";
  const deadlineSeconds = useMemo(() => deadline ? Math.floor(new Date(deadline).getTime() / 1000) : 0, [deadline]);
  if (!isOwner) return null;

  async function run(action: () => Promise<void>, success: string) {
    setBusy(true); setMessage(null);
    try { await action(); setMessage(success); }
    catch (cause) { setMessage(plainContractError(cause)); }
    finally { setBusy(false); }
  }

  return <section className="action-panel" aria-labelledby="owner-actions-title">
    <div className="section-heading"><h2 id="owner-actions-title">Owner actions</h2><span>Task #{task.task_id}</span></div>
    <div className="owner-actions">
      {canEdit && <><label>Additional reward<input inputMode="numeric" value={reward} onChange={(event) => setReward(event.target.value)} placeholder="Token units" /></label><button disabled={!operations || busy || !/^\d+$/.test(reward) || BigInt(reward || 0) <= 0n} onClick={() => void run(() => operations!.increaseReward(task.owner, task.task_id, BigInt(reward)), "Reward increase submitted.")}><CircleDollarSign />Increase reward</button>
      <label>New deadline<input type="datetime-local" value={deadline} onChange={(event) => setDeadline(event.target.value)} /></label><button disabled={!operations || busy || deadlineSeconds <= Math.max(Date.now() / 1000, task.deadline)} onClick={() => void run(() => operations!.extendDeadline(task.owner, task.task_id, deadlineSeconds), "Deadline extension submitted.")}><CalendarClock />Extend deadline</button></>}
      {canCancel && <button className="danger-button" disabled={!operations || busy} onClick={() => void run(() => operations!.cancelTask(task.owner, task.task_id), "Cancellation submitted.")}><Ban />Cancel task</button>}
    </div>
    {!operations && <p className="form-note">Connect the owner wallet to enable task actions.</p>}
    {message && <p className="form-message" role="status">{message}</p>}
  </section>;
}

export function plainContractError(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause);
  if (/paused/i.test(message)) return "The protocol is paused. Try again after operations resume.";
  if (/authori[sz]|signature|auth/i.test(message)) return "This wallet is not authorized for that action.";
  if (/deadline|expired/i.test(message)) return "The task deadline no longer permits that change.";
  if (/status|state|claimed|executed|cancelled/i.test(message)) return "The task changed state and this action is no longer allowed.";
  if (/reward|amount|positive/i.test(message)) return "Enter a positive reward amount accepted by the protocol.";
  return "The contract rejected the transaction. Refresh the task and try again.";
}
