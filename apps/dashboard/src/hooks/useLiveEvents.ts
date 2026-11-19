import { useEffect, useRef, useState } from "react";
import { useNetwork } from "../config";

export type LiveState = "connecting" | "live" | "stale";

export function useLiveEvents(onEvent: () => void): LiveState {
  const { network } = useNetwork();
  const [state, setState] = useState<LiveState>("connecting");
  const callback = useRef(onEvent);
  const cursor = useRef<number | undefined>();
  callback.current = onEvent;

  useEffect(() => {
    if (!network.indexerUrl) { setState("stale"); return; }
    let socket: WebSocket | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    let attempts = 0;
    const connect = () => {
      const base = network.indexerUrl.replace(/^http/, "ws").replace(/\/+$/, "");
      const url = new URL(`${base}/stream`);
      if (cursor.current !== undefined) url.searchParams.set("after", String(cursor.current));
      setState(attempts === 0 ? "connecting" : "stale");
      socket = new WebSocket(url);
      socket.addEventListener("open", () => { attempts = 0; setState("live"); });
      socket.addEventListener("message", (message) => {
        try {
          const payload = JSON.parse(String(message.data)) as { kind?: string; event?: { cursor?: number } };
          if (payload.kind === "event") { if (typeof payload.event?.cursor === "number") cursor.current = payload.event.cursor; callback.current(); }
        } catch { setState("stale"); }
      });
      socket.addEventListener("close", () => {
        if (stopped) return;
        setState("stale");
        retry = setTimeout(connect, Math.min(30_000, 1_000 * 2 ** attempts++));
      });
      socket.addEventListener("error", () => setState("stale"));
    };
    connect();
    return () => { stopped = true; if (retry) clearTimeout(retry); socket?.close(); };
  }, [network.indexerUrl]);
  return state;
}
