import { Send } from "lucide-react";
import { useMemo, useState } from "react";
import { StrKey } from "@stellar/stellar-sdk";
import { useDashboardData } from "../data/context";
import type { RegisterTaskInput } from "../data/types";

const MAX_CALLDATA_BYTES = 1024;

export function RegisterTaskPage() {
  const { operations, account } = useDashboardData();
  const [target, setTarget] = useState("");
  const [functionName, setFunctionName] = useState("");
  const [argumentsJson, setArgumentsJson] = useState("[]");
  const [reward, setReward] = useState("");
  const [deadline, setDeadline] = useState("");
  const [verifier, setVerifier] = useState("");
  const [fee, setFee] = useState<bigint | null>(null);
  const [taskId, setTaskId] = useState<bigint | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const validation = useMemo(() => validate({ account, target, functionName, argumentsJson, reward, deadline, verifier }), [account, argumentsJson, deadline, functionName, reward, target, verifier]);
  const input = (): RegisterTaskInput => ({ owner: account!, target, functionName, argumentsJson, reward: BigInt(reward), deadline: Math.floor(new Date(deadline).getTime() / 1000), ...(verifier ? { verifier } : {}) });
  async function estimate() { if (!operations || validation) return; setBusy(true); setMessage(null); try { setFee(await operations.estimateRegisterTask(input())); } catch (cause) { setMessage(cause instanceof Error ? cause.message : "Fee estimate failed"); } finally { setBusy(false); } }
  async function submit() { if (!operations || validation || fee === null) return; setBusy(true); setMessage(null); try { setTaskId(await operations.registerTask(input())); } catch (cause) { setMessage(cause instanceof Error ? cause.message : "Registration failed"); } finally { setBusy(false); } }

  return <section className="page narrow-page"><div className="page-heading"><div><p className="eyebrow">Owner operation</p><h1>Register task</h1><p>Validate the call payload and review the network fee before signing.</p></div></div>
    <form className="form-grid" onSubmit={(event) => { event.preventDefault(); void (fee === null ? estimate() : submit()); }}>
      <label className="span-2">Target contract<input value={target} onChange={(event) => { setTarget(event.target.value.trim()); setFee(null); }} placeholder="C..." /></label>
      <label>Function<input value={functionName} onChange={(event) => { setFunctionName(event.target.value); setFee(null); }} placeholder="rebalance" /></label>
      <label>Reward<input inputMode="numeric" value={reward} onChange={(event) => { setReward(event.target.value); setFee(null); }} placeholder="1000000" /></label>
      <label>Deadline<input type="datetime-local" value={deadline} onChange={(event) => { setDeadline(event.target.value); setFee(null); }} /></label>
      <label>Verifier (optional)<input value={verifier} onChange={(event) => { setVerifier(event.target.value.trim()); setFee(null); }} placeholder="C..." /></label>
      <label className="span-2">Arguments (JSON array)<textarea value={argumentsJson} onChange={(event) => { setArgumentsJson(event.target.value); setFee(null); }} rows={7} /></label>
      <div className="span-2 form-footer"><div>{validation ? <p className="field-error" role="alert">{validation}</p> : fee !== null ? <p>Estimated fee: <strong>{fee.toLocaleString()} stroops</strong></p> : <p className="form-note">The fee is simulated before the wallet prompt.</p>}{message && <p className="field-error" role="alert">{message}</p>}{taskId !== null && <p className="success" role="status">Task #{taskId.toString()} registered.</p>}</div><button className="primary-button" disabled={Boolean(validation) || !operations || busy}><Send />{fee === null ? "Estimate fee" : "Sign and register"}</button></div>
    </form>
  </section>;
}

function validate(values: { account?: string; target: string; functionName: string; argumentsJson: string; reward: string; deadline: string; verifier: string }): string | null {
  if (!values.account) return "Connect a wallet before registering a task.";
  if (!StrKey.isValidEd25519PublicKey(values.account)) return "The connected wallet account is invalid.";
  if (!StrKey.isValidContract(values.target)) return "Enter a valid Stellar contract target.";
  if (!/^[a-zA-Z][a-zA-Z0-9_]{0,31}$/.test(values.functionName)) return "Function names must be 1-32 letters, digits, or underscores.";
  let args: unknown;
  try { args = JSON.parse(values.argumentsJson); } catch { return "Arguments must be valid JSON."; }
  if (!Array.isArray(args)) return "Arguments must be a JSON array.";
  if (new TextEncoder().encode(JSON.stringify({ target: values.target, function: values.functionName, args })).length > MAX_CALLDATA_BYTES) return `Encoded call data exceeds ${MAX_CALLDATA_BYTES} bytes.`;
  if (!/^\d+$/.test(values.reward) || BigInt(values.reward) <= 0n) return "Reward must be a positive integer.";
  const deadline = new Date(values.deadline).getTime();
  if (!Number.isFinite(deadline) || deadline <= Date.now()) return "Deadline must be in the future.";
  if (values.verifier && !StrKey.isValidContract(values.verifier)) return "Verifier must be a valid contract address.";
  return null;
}
