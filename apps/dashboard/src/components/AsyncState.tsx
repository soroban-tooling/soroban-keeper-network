import { AlertCircle, LoaderCircle } from "lucide-react";

export function LoadingState({ label = "Loading" }: { label?: string }) {
  return <div className="state"><LoaderCircle className="spin" aria-hidden="true" /><span>{label}</span></div>;
}

export function ErrorState({ message, retry }: { message: string; retry?: () => void }) {
  return <div className="state state-error" role="alert"><AlertCircle aria-hidden="true" /><span>{message}</span>{retry && <button onClick={retry}>Retry</button>}</div>;
}

export function EmptyState({ message }: { message: string }) {
  return <div className="state"><span>{message}</span></div>;
}
