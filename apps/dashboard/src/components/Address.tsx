import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { truncateAddress } from "../format";

export interface AddressProps {
  value?: string | null;
  start?: number;
  end?: number;
  copyable?: boolean;
}

export function Address({ value, start = 8, end = 6, copyable = true }: AddressProps) {
  const [copied, setCopied] = useState(false);

  if (!value) return <span className="muted">None</span>;

  const truncated = truncateAddress(value, start, end);

  const handleCopy = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard) {
        await navigator.clipboard.writeText(value);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }
    } catch {
      // clipboard write failed silently
    }
  };

  return (
    <span className="address-wrapper" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <code title={value}>{truncated}</code>
      {copyable && (
        <button
          type="button"
          onClick={handleCopy}
          className="address-copy-btn"
          title={copied ? "Copied to clipboard!" : `Copy address ${value}`}
          aria-label={copied ? "Address copied" : `Copy address ${value}`}
          style={{
            background: "transparent",
            border: "none",
            cursor: "pointer",
            padding: "2px",
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            color: copied ? "var(--success, #16a34a)" : "var(--ink-muted, #888)",
            borderRadius: "4px",
            lineHeight: 1,
          }}
        >
          {copied ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
        </button>
      )}
    </span>
  );
}
