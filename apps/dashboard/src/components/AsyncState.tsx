import { AlertCircle, Database, HelpCircle, Inbox, LoaderCircle, RefreshCw, Server, WifiOff } from "lucide-react";
import React from "react";
import { IndexerRequestError } from "../data/indexer";

export type ErrorSource = "indexer" | "rpc" | "general";

export interface FormattedError {
  source: ErrorSource;
  title: string;
  message: string;
}

/**
 * Distinguishes between errors originating from the event indexer vs Stellar RPC / contract calls.
 */
export function classifyError(error: unknown, defaultSource?: ErrorSource): FormattedError {
  if (error instanceof IndexerRequestError) {
    return {
      source: "indexer",
      title: "Indexer Service Error",
      message: `The indexing service returned status ${error.status} (${error.message}). The indexer may still be syncing historical blocks or undergoing maintenance.`,
    };
  }

  const rawMsg = error instanceof Error ? error.message : String(error ?? "An unexpected error occurred");
  const lower = rawMsg.toLowerCase();

  // RPC / Soroban contract errors
  if (
    lower.includes("rpc") ||
    lower.includes("soroban") ||
    lower.includes("simulation") ||
    lower.includes("contract") ||
    lower.includes("transaction") ||
    lower.includes("ledger") ||
    lower.includes("freighter") ||
    lower.includes("horizon") ||
    defaultSource === "rpc"
  ) {
    return {
      source: "rpc",
      title: "Stellar RPC Error",
      message: `Direct contract RPC call failed: ${rawMsg}. Check your connection to the Stellar RPC node or contract availability.`,
    };
  }

  // Indexer errors
  if (lower.includes("indexer") || lower.includes("event") || defaultSource === "indexer") {
    return {
      source: "indexer",
      title: "Indexer Service Error",
      message: `Failed to fetch indexed network data: ${rawMsg}. Verify that the indexer backend is running and reachable.`,
    };
  }

  return {
    source: defaultSource ?? "general",
    title: "Application Error",
    message: rawMsg,
  };
}

export function Skeleton({
  width,
  height,
  borderRadius = 4,
  style,
  className = "",
}: {
  width?: string | number;
  height?: string | number;
  borderRadius?: string | number;
  style?: React.CSSProperties;
  className?: string;
}) {
  return (
    <div
      className={`skeleton-shimmer ${className}`}
      style={{
        width: width ?? "100%",
        height: height ?? 16,
        borderRadius,
        ...style,
      }}
      aria-hidden="true"
    />
  );
}

export function TableSkeleton({ rows = 5, columns = 5 }: { rows?: number; columns?: number }) {
  return (
    <div className="table-wrap skeleton-table" aria-label="Loading table data" aria-busy="true">
      <table>
        <thead>
          <tr>
            {Array.from({ length: columns }).map((_, i) => (
              <th key={i}>
                <Skeleton height={14} width="70%" />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: rows }).map((_, r) => (
            <tr key={r}>
              {Array.from({ length: columns }).map((_, c) => (
                <td key={c}>
                  <Skeleton height={16} width={c === 0 ? "50%" : c === columns - 1 ? "40%" : "80%"} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function CardsSkeleton({ count = 4 }: { count?: number }) {
  return (
    <div className="metric-grid skeleton-cards" aria-busy="true">
      {Array.from({ length: count }).map((_, i) => (
        <article key={i}>
          <Skeleton height={14} width="40%" style={{ marginBottom: 8 }} />
          <Skeleton height={28} width="75%" style={{ marginBottom: 6 }} />
          <Skeleton height={12} width="50%" />
        </article>
      ))}
    </div>
  );
}

export interface LoadingStateProps {
  label?: string;
  skeleton?: "table" | "cards" | "detail" | "none";
  rows?: number;
  columns?: number;
  count?: number;
}

export function LoadingState({
  label = "Loading...",
  skeleton = "none",
  rows = 5,
  columns = 5,
  count = 4,
}: LoadingStateProps) {
  if (skeleton === "table") {
    return (
      <div className="loading-state-wrapper">
        <div className="state-inline-indicator">
          <LoaderCircle className="spin" size={16} aria-hidden="true" />
          <span>{label}</span>
        </div>
        <TableSkeleton rows={rows} columns={columns} />
      </div>
    );
  }

  if (skeleton === "cards") {
    return (
      <div className="loading-state-wrapper">
        <div className="state-inline-indicator">
          <LoaderCircle className="spin" size={16} aria-hidden="true" />
          <span>{label}</span>
        </div>
        <CardsSkeleton count={count} />
      </div>
    );
  }

  return (
    <div className="state" role="status" aria-busy="true">
      <LoaderCircle className="spin" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

export interface ErrorStateProps {
  message?: string;
  error?: unknown;
  source?: ErrorSource;
  retry?: () => void;
}

export function ErrorState({ message, error, source, retry }: ErrorStateProps) {
  const details = classifyError(error ?? message, source);
  const SourceIcon = details.source === "indexer" ? Database : details.source === "rpc" ? Server : WifiOff;

  return (
    <div className="state state-error-card" role="alert" style={{ flexDirection: "column", alignItems: "flex-start", gap: 12, padding: "24px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, width: "100%" }}>
        <AlertCircle size={20} className="danger-text" aria-hidden="true" />
        <strong style={{ fontSize: "1.05rem" }}>{details.title}</strong>
        <span
          className={`source-badge source-${details.source}`}
          style={{
            marginLeft: "auto",
            fontSize: "0.75rem",
            textTransform: "uppercase",
            fontWeight: 600,
            padding: "2px 8px",
            borderRadius: 4,
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
            background: details.source === "indexer" ? "rgba(59, 130, 246, 0.15)" : "rgba(234, 88, 12, 0.15)",
            color: details.source === "indexer" ? "#3b82f6" : "#ea580c",
            border: `1px solid ${details.source === "indexer" ? "rgba(59, 130, 246, 0.3)" : "rgba(234, 88, 12, 0.3)"}`,
          }}
        >
          <SourceIcon size={12} />
          {details.source}
        </span>
      </div>
      <p style={{ margin: 0, color: "var(--ink-muted)", fontSize: "0.92rem", lineHeight: 1.5 }}>
        {details.message}
      </p>
      {retry && (
        <button
          type="button"
          onClick={retry}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            marginTop: 4,
            padding: "8px 16px",
            borderRadius: 6,
            cursor: "pointer",
            background: "var(--surface)",
            color: "var(--ink)",
            border: "1px solid var(--line)",
            fontWeight: 500,
          }}
        >
          <RefreshCw size={14} aria-hidden="true" />
          <span>Retry request</span>
        </button>
      )}
    </div>
  );
}

export interface EmptyStateProps {
  title?: string;
  message: string;
  explanation?: string;
  action?: {
    label: string;
    onClick: () => void;
  };
  icon?: React.ReactNode;
}

export function EmptyState({ title, message, explanation, action, icon }: EmptyStateProps) {
  return (
    <div className="state empty-state-card" style={{ flexDirection: "column", gap: 12, padding: "32px 20px", textAlign: "center" }}>
      <div style={{ color: "var(--ink-muted)", opacity: 0.7 }}>
        {icon ?? <Inbox size={36} aria-hidden="true" />}
      </div>
      {title && <h3 style={{ margin: 0, fontSize: "1.1rem" }}>{title}</h3>}
      <p style={{ margin: 0, maxWidth: 500, color: "var(--ink-muted)", fontSize: "0.92rem", lineHeight: 1.5 }}>
        {message}
      </p>
      {explanation && (
        <small style={{ color: "var(--ink-muted)", opacity: 0.8, maxWidth: 450 }}>
          <HelpCircle size={12} style={{ display: "inline", verticalAlign: "middle", marginRight: 4 }} />
          {explanation}
        </small>
      )}
      {action && (
        <button
          type="button"
          onClick={action.onClick}
          style={{
            marginTop: 8,
            padding: "8px 16px",
            borderRadius: 6,
            cursor: "pointer",
            background: "var(--accent, #3b82f6)",
            color: "#fff",
            border: "none",
            fontWeight: 500,
          }}
        >
          {action.label}
        </button>
      )}
    </div>
  );
}
