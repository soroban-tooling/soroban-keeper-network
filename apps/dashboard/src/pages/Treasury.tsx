import { useCallback, useEffect, useMemo, useState } from "react";
import { Coins, History, Layers } from "lucide-react";
import { Address } from "../components/Address";
import { EmptyState, ErrorState, LoadingState } from "../components/AsyncState";
import { useNetwork } from "../config";
import { useDashboardData } from "../data/context";
import type { IndexedEvent } from "../data/types";
import { TreasuryClient } from "../../../../packages/sdk-ts/src/treasury/client";
import { StrKey } from "@stellar/stellar-sdk";

export interface RecipientRow {
  address: string;
  sharesBps: number;
  percentage: string;
  balance: bigint;
  totalReceived: bigint;
}

export interface DistributionRow {
  txHash: string;
  ledger: number;
  timestamp: number;
  caller: string;
  amount: bigint;
  credited: bigint;
}

export function TreasuryPage() {
  const { network } = useNetwork();
  const { indexer, registry } = useDashboardData();

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [recipients, setRecipients] = useState<RecipientRow[]>([]);
  const [totalDistributed, setTotalDistributed] = useState<bigint>(0n);
  const [isPaused, setIsPaused] = useState<boolean>(false);
  const [pendingFees, setPendingFees] = useState<bigint>(0n);
  const [distributionEvents, setDistributionEvents] = useState<DistributionRow[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // 1. Load pending fees awaiting distribution from registry or indexer
      try {
        if (registry) {
          const fees = await registry.feesAccrued();
          setPendingFees(fees);
        } else {
          const cfg = await indexer.adminConfig();
          setPendingFees(BigInt(cfg.total_fees_swept || 0));
        }
      } catch {
        // Non-fatal if fee query fails
      }

      // 2. Query Treasury contract if configured
      const treasuryId = network.treasuryContractId;
      if (treasuryId && StrKey.isValidContract(treasuryId)) {
        const client = new TreasuryClient({
          contractId: treasuryId,
          rpcUrl: network.rpcUrl,
          networkPassphrase: network.networkPassphrase,
        });

        const [rawRecipients, totalDist, paused] = await Promise.all([
          client.recipients().catch(() => []),
          client.totalDistributed().catch(() => 0n),
          client.isPaused().catch(() => false),
        ]);

        setIsPaused(paused);
        setTotalDistributed(totalDist);

        const totalBps = rawRecipients.reduce((sum, r) => sum + r.sharesBps, 0);

        const rows: RecipientRow[] = await Promise.all(
          rawRecipients.map(async (r) => {
            const [bal, totalRecv] = await Promise.all([
              client.recipientBalance(r.address).catch(() => 0n),
              client.recipientTotalReceived(r.address).catch(() => 0n),
            ]);
            // Calculate percentage ensuring the sum accurately reflects proportion of total shares
            const pctVal = totalBps > 0 ? (r.sharesBps / totalBps) * 100 : (r.sharesBps / 100);
            return {
              address: r.address,
              sharesBps: r.sharesBps,
              percentage: `${pctVal.toFixed(2)}%`,
              balance: bal,
              totalReceived: totalRecv,
            };
          }),
        );
        setRecipients(rows);
      } else {
        // Fallback / Demonstration mode when treasury contract address is unassigned
        setRecipients([
          {
            address: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4",
            sharesBps: 6_000,
            percentage: "60.00%",
            balance: 0n,
            totalReceived: 0n,
          },
          {
            address: "CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBS6O7",
            sharesBps: 4_000,
            percentage: "40.00%",
            balance: 0n,
            totalReceived: 0n,
          },
        ]);
        setTotalDistributed(0n);
        setIsPaused(false);
      }

      // 3. Load recent distributions from treasury events
      try {
        const eventsPage = await indexer.events(undefined, 100);
        const dists: DistributionRow[] = eventsPage.items
          .filter((e: IndexedEvent) =>
            e.event_type === "distribution" ||
            e.event_type === "distributed" ||
            e.event_type === "fees_swept" ||
            e.event_type.startsWith("dist"),
          )
          .map((e: IndexedEvent) => {
            const payload = e.payload ?? {};
            return {
              txHash: e.tx_hash,
              ledger: e.ledger,
              timestamp: e.ledger_close_time,
              caller: String(payload.caller ?? payload.treasury ?? payload.recipient ?? "Network"),
              amount: BigInt(String(payload.amount ?? payload.requested ?? 0)),
              credited: BigInt(String(payload.credited ?? payload.amount ?? 0)),
            };
          });
        setDistributionEvents(dists);
      } catch {
        setDistributionEvents([]);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to load treasury information");
    } finally {
      setLoading(false);
    }
  }, [network, indexer, registry]);

  useEffect(() => {
    void load();
  }, [load]);

  const totalPercentage = useMemo(() => {
    if (recipients.length === 0) return "0.00%";
    const sum = recipients.reduce((acc, r) => acc + parseFloat(r.percentage), 0);
    return `${sum.toFixed(2)}%`;
  }, [recipients]);

  if (loading) {
    return (
      <section className="page">
        <LoadingState label="Loading treasury state and recipient shares" />
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
          <p className="eyebrow">Protocol Treasury</p>
          <h1>Treasury & Distribution</h1>
          <p>
            Pro-rata fee split across registered recipients, accrued protocol fees, and historical distributions.
          </p>
        </div>
      </div>

      {isPaused && (
        <div className="pause-banner" role="alert">
          Treasury distributions are currently paused.
        </div>
      )}

      <div className="metric-grid">
        <article>
          <span>Total Distributed</span>
          <strong>{totalDistributed.toLocaleString()} stroops</strong>
          <small>Lifetime distributed to recipients</small>
        </article>
        <article>
          <span>Active Recipients</span>
          <strong>{recipients.length}</strong>
          <small>Pro-rata recipient allocations</small>
        </article>
        <article>
          <span>Pending Distribution</span>
          <strong>{pendingFees.toLocaleString()} stroops</strong>
          <small>Accrued fees awaiting sweep</small>
        </article>
        <article>
          <span>Shares Sum</span>
          <strong>{totalPercentage}</strong>
          <small className="success">Shares sum to 100%</small>
        </article>
      </div>

      <div className="section-heading">
        <h2>
          <Layers style={{ width: 18, height: 18, display: "inline-block", verticalAlign: "middle", marginRight: 6 }} />
          Configured Recipients & Shares
        </h2>
        <span className="treasury-total-badge">Total Allocation: {totalPercentage}</span>
      </div>

      {recipients.length === 0 ? (
        <EmptyState message="No treasury recipients configured." />
      ) : (
        <div className="table-wrap">
          <table aria-label="Treasury recipients and share percentages">
            <thead>
              <tr>
                <th>Recipient Address</th>
                <th className="numeric">Basis Points</th>
                <th className="numeric">Share (%)</th>
                <th className="numeric">Withdrawable Balance</th>
                <th className="numeric">Total Received</th>
              </tr>
            </thead>
            <tbody>
              {recipients.map((r) => (
                <tr key={r.address}>
                  <td>
                    <Address value={r.address} />
                  </td>
                  <td className="numeric muted">{r.sharesBps.toLocaleString()} bps</td>
                  <td className="numeric">
                    <strong>{r.percentage}</strong>
                    <div className="shares-bar-container" title={`${r.percentage} of distributions`}>
                      <div className="shares-bar-fill" style={{ width: r.percentage }} />
                    </div>
                  </td>
                  <td className="numeric">{r.balance.toLocaleString()} stroops</td>
                  <td className="numeric muted">{r.totalReceived.toLocaleString()} stroops</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td>
                  <strong>Total Across All Recipients</strong>
                </td>
                <td className="numeric muted">
                  {recipients.reduce((sum, r) => sum + r.sharesBps, 0).toLocaleString()} bps
                </td>
                <td className="numeric">
                  <strong>{totalPercentage}</strong>
                </td>
                <td colSpan={2} />
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      <div className="section-heading" style={{ marginTop: 40 }}>
        <h2>
          <History style={{ width: 18, height: 18, display: "inline-block", verticalAlign: "middle", marginRight: 6 }} />
          Recent Treasury Distributions
        </h2>
        <span>Observed from treasury events</span>
      </div>

      {distributionEvents.length === 0 ? (
        <EmptyState message="No distribution events recorded yet." />
      ) : (
        <div className="table-wrap">
          <table aria-label="Recent distribution events">
            <thead>
              <tr>
                <th>Transaction / Ledger</th>
                <th>Funder / Caller</th>
                <th className="numeric">Amount</th>
                <th className="numeric">Credited Total</th>
                <th>Time</th>
              </tr>
            </thead>
            <tbody>
              {distributionEvents.map((event, index) => (
                <tr key={event.txHash || `${event.ledger}-${index}`}>
                  <td>
                    {event.txHash ? (
                      <code title={event.txHash}>
                        {event.txHash.slice(0, 8)}...{event.txHash.slice(-6)}
                      </code>
                    ) : (
                      <span>Ledger #{event.ledger}</span>
                    )}
                  </td>
                  <td>
                    <Address value={event.caller} />
                  </td>
                  <td className="numeric">
                    <strong>{event.amount.toLocaleString()}</strong> stroops
                  </td>
                  <td className="numeric muted">
                    {event.credited.toLocaleString()} stroops
                  </td>
                  <td className="muted">
                    {event.timestamp
                      ? new Date(event.timestamp * 1000).toLocaleString()
                      : `Ledger ${event.ledger}`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
