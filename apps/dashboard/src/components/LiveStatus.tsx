import { CloudOff } from "lucide-react";
import type { LiveState } from "../hooks/useLiveEvents";

export function LiveStatus({ state }: { state: LiveState }) {
  if (state === "live") return <span className="live-mark"><span />Live</span>;
  if (state === "connecting") return <span className="muted">Connecting live updates...</span>;
  return <span className="stale-mark" role="status"><CloudOff />Live updates disconnected; showing indexed data</span>;
}
