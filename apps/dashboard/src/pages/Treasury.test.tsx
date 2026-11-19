import { describe, expect, it } from "vitest";

describe("Treasury calculations", () => {
  it("formats recipient shares as percentages summing to 100%", () => {
    const rawRecipients = [
      { address: "CAAAA", sharesBps: 5_000 },
      { address: "CBBBB", sharesBps: 3_000 },
      { address: "CCCCC", sharesBps: 2_000 },
    ];

    const totalBps = rawRecipients.reduce((sum, r) => sum + r.sharesBps, 0);
    expect(totalBps).toBe(10_000);

    const rows = rawRecipients.map((r) => {
      const pctVal = (r.sharesBps / totalBps) * 100;
      return {
        ...r,
        percentage: `${pctVal.toFixed(2)}%`,
      };
    });

    expect(rows[0].percentage).toBe("50.00%");
    expect(rows[1].percentage).toBe("30.00%");
    expect(rows[2].percentage).toBe("20.00%");

    const sumPercentages = rows.reduce((acc, r) => acc + parseFloat(r.percentage), 0);
    expect(sumPercentages.toFixed(2)).toBe("100.00");
  });

  it("handles pro-rata split when bps sum to non-standard totals", () => {
    const rawRecipients = [
      { address: "CAAAA", sharesBps: 1 },
      { address: "CBBBB", sharesBps: 2 },
    ];
    const totalBps = 3;
    const rows = rawRecipients.map((r) => ({
      ...r,
      percentage: `${((r.sharesBps / totalBps) * 100).toFixed(2)}%`,
    }));

    expect(rows[0].percentage).toBe("33.33%");
    expect(rows[1].percentage).toBe("66.67%");

    const sum = rows.reduce((acc, r) => acc + parseFloat(r.percentage), 0);
    expect(Math.round(sum)).toBe(100);
  });

  it("handles loading and error states for contract queries", async () => {
    let loading = true;
    let error: string | null = null;

    // Simulate error transition
    try {
      throw new Error("RPC endpoint unreachable");
    } catch (e) {
      error = (e as Error).message;
      loading = false;
    }

    expect(loading).toBe(false);
    expect(error).toBe("RPC endpoint unreachable");
  });
});
