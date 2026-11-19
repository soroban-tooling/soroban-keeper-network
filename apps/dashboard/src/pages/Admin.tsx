import { useCallback, useEffect, useState } from "react";
import { ShieldCheck, Info, Terminal } from "lucide-react";
import { Address } from "../components/Address";
import { ErrorState, LoadingState } from "../components/AsyncState";
import { useDashboardData } from "../data/context";

interface AdminParameters {
  adminAddress?: string;
  feeBps: number;
  minReward: bigint;
  minStake: bigint;
  disputeWindow: number;
  reputationFloor: number;
  paused: boolean;
}

export function AdminPage() {
  const { registry, indexer } = useDashboardData();

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [params, setParams] = useState<AdminParameters>({
    adminAddress: undefined,
    feeBps: 250,
    minReward: 10_000_000n,
    minStake: 50_000_000n,
    disputeWindow: 1_200,
    reputationFloor: 1_000,
    paused: false,
  });

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      if (registry) {
        const [
          adminAddr,
          feeBps,
          minRew,
          minStk,
          dispWin,
          repFloor,
          paused,
        ] = await Promise.all([
          registry.admin?.().catch(() => undefined),
          registry.getFeeBps().catch(() => 250),
          registry.minReward?.().catch(() => 10_000_000n) ?? 10_000_000n,
          registry.minStake?.().catch(() => 50_000_000n) ?? 50_000_000n,
          registry.disputeWindow?.().catch(() => 1_200) ?? 1_200,
          registry.reputationFloor?.().catch(() => 1_000) ?? 1_000,
          registry.isPaused().catch(() => false),
        ]);

        setParams({
          adminAddress: adminAddr,
          feeBps,
          minReward: minRew,
          minStake: minStk,
          disputeWindow: dispWin,
          reputationFloor: repFloor,
          paused,
        });
      } else {
        const cfg = await indexer.adminConfig().catch(() => ({
          fee_bps: 250,
          paused: false,
          total_fees_swept: "0",
        }));
        setParams((prev) => ({
          ...prev,
          feeBps: cfg.fee_bps ?? 250,
          paused: cfg.paused ?? false,
        }));
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to load administration status");
    } finally {
      setLoading(false);
    }
  }, [registry, indexer]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) {
    return (
      <section className="page">
        <LoadingState label="Loading protocol parameters" />
      </section>
    );
  }

  if (error) {
    return (
      <section className="page">
        <ErrorState message={error} retry={() => void load()} />
      </section>
    );
  }

  return (
    <section className="page">
      <div className="page-heading">
        <div>
          <p className="eyebrow">Governance & Security</p>
          <h1>Admin Status Panel</h1>
          <p>
            Protocol-wide administrative parameters and security policies. Read-only by design.
          </p>
        </div>
      </div>

      <div className="notice" role="note">
        <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
          <Info style={{ width: 20, height: 20, flexShrink: 0, marginTop: 2 }} />
          <div>
            <strong>Read-only administrative overview</strong>
            <p style={{ margin: "4px 0 0", fontSize: 13 }}>
              This panel displays the live on-chain governance parameters configured for the Soroban Keeper Network.
              To maintain security, write operations are not exposed in the web interface; all administrative mutations
              must be authorized and submitted via the designated CLI tool (<code>skn admin</code>).
            </p>
          </div>
        </div>
      </div>

      {params.paused && (
        <div className="pause-banner" role="alert">
          Protocol operations are currently PAUSED by administrative action.
        </div>
      )}

      <div className="admin-grid">
        {/* 1. Admin Address */}
        <article className="admin-param-card">
          <header>
            <h2>Admin Address</h2>
            <span className="admin-param-badge">Access Control</span>
          </header>
          <div className="admin-param-value">
            <Address value={params.adminAddress} />
          </div>
          <p className="admin-param-desc">
            The privileged account authorized to upgrade the contract, adjust protocol fees, pause operations,
            and modify system-wide economic thresholds.
          </p>
        </article>

        {/* 2. Fee Bps */}
        <article className="admin-param-card">
          <header>
            <h2>Protocol Fee (Fee Bps)</h2>
            <span className="admin-param-badge">Economics</span>
          </header>
          <div className="admin-param-value">
            {params.feeBps} bps <small className="muted" style={{ fontSize: 14, fontWeight: 400 }}>({(params.feeBps / 100).toFixed(2)}%)</small>
          </div>
          <p className="admin-param-desc">
            The percentage withheld in basis points from the gross reward of every executed task. Accrued on-chain
            and periodically swept to the protocol treasury for distribution.
          </p>
        </article>

        {/* 3. Minimum Reward */}
        <article className="admin-param-card">
          <header>
            <h2>Minimum Task Reward</h2>
            <span className="admin-param-badge">Validation Floor</span>
          </header>
          <div className="admin-param-value">
            {params.minReward.toLocaleString()} <small className="muted" style={{ fontSize: 14, fontWeight: 400 }}>stroops</small>
          </div>
          <p className="admin-param-desc">
            The smallest escrow reward an owner may deposit when creating a task. Tasks registered with rewards
            below this floor are rejected to prevent spam and uneconomical work.
          </p>
        </article>

        {/* 4. Minimum Keeper Stake */}
        <article className="admin-param-card">
          <header>
            <h2>Minimum Keeper Stake</h2>
            <span className="admin-param-badge">Sybil Defense</span>
          </header>
          <div className="admin-param-value">
            {params.minStake.toLocaleString()} <small className="muted" style={{ fontSize: 14, fontWeight: 400 }}>stroops</small>
          </div>
          <p className="admin-param-desc">
            The minimum active stake a keeper must deposit before claiming and executing tasks. Serves as collateral
            that can be slashed in the event of proven malicious execution or invalid claims.
          </p>
        </article>

        {/* 5. Dispute Window */}
        <article className="admin-param-card">
          <header>
            <h2>Dispute Window</h2>
            <span className="admin-param-badge">Verification</span>
          </header>
          <div className="admin-param-value">
            {params.disputeWindow.toLocaleString()} <small className="muted" style={{ fontSize: 14, fontWeight: 400 }}>ledgers</small>
          </div>
          <p className="admin-param-desc">
            The observation time window in ledgers following task execution during which verifiers or owners
            can dispute an execution before rewards become finalized for withdrawal.
          </p>
        </article>

        {/* 6. Reputation Floor */}
        <article className="admin-param-card">
          <header>
            <h2>Reputation Floor</h2>
            <span className="admin-param-badge">Quality Gate</span>
          </header>
          <div className="admin-param-value">
            {params.reputationFloor} bps <small className="muted" style={{ fontSize: 14, fontWeight: 400 }}>({(params.reputationFloor / 100).toFixed(2)}%)</small>
          </div>
          <p className="admin-param-desc">
            The minimum reputation score a keeper must hold to claim tasks. Untracked keepers or keepers whose score
            drops below this threshold are locked out until restaked or rehabilitated.
          </p>
        </article>
      </div>

      <div style={{ marginTop: 24, padding: "16px 20px", background: "var(--surface)", border: "1px solid var(--line)", borderRadius: 6 }}>
        <h3 style={{ fontSize: 14, margin: "0 0 8px", display: "flex", alignItems: "center", gap: 8 }}>
          <Terminal style={{ width: 16, height: 16 }} />
          Administrative CLI Reference
        </h3>
        <p style={{ margin: "0 0 10px", fontSize: 13, color: "var(--ink-muted)" }}>
          To update any of the parameters above, use the signed CLI operations:
        </p>
        <pre style={{ margin: 0, padding: 12, background: "var(--surface-subtle)", borderRadius: 4, fontSize: 12, overflowX: "auto" }}>
          <code>
            # Adjust protocol fee{"\n"}
            skn admin set-fee-bps --fee-bps &lt;BPS&gt; --admin &lt;ADMIN_KEY&gt;{"\n\n"}
            # Update minimum task reward{"\n"}
            skn admin set-min-reward --amount &lt;STROOPS&gt; --admin &lt;ADMIN_KEY&gt;{"\n\n"}
            # Adjust keeper staking threshold{"\n"}
            skn admin set-min-stake --amount &lt;STROOPS&gt; --admin &lt;ADMIN_KEY&gt;{"\n\n"}
            # Configure dispute window and reputation floor{"\n"}
            skn admin set-dispute-window --ledgers &lt;COUNT&gt; --admin &lt;ADMIN_KEY&gt;{"\n"}
            skn admin set-reputation-floor --floor &lt;BPS&gt; --admin &lt;ADMIN_KEY&gt;
          </code>
        </pre>
      </div>
    </section>
  );
}
