export function Address({ value }: { value?: string | null }) {
  if (!value) return <span className="muted">None</span>;
  return <code title={value}>{value.length > 16 ? `${value.slice(0, 8)}...${value.slice(-6)}` : value}</code>;
}
