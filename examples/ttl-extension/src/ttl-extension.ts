/**
 * Soroban Storage TTL Extension Engine & Cost Model
 *
 * Simulates and calculates storage lifetimes, expiration, renewal triggers,
 * and cost economics for dApp owners using the Soroban Keeper Network.
 */

export interface StorageEntry {
  key: string;
  sizeBytes: number;
  naturalTtlLedgers: number;
  currentTtlLedgers: number;
  lastUpdatedLedger: number;
  data: unknown;
  isArchived: boolean;
}

export interface OwnerCostEstimate {
  storageRentStroops: bigint;
  keeperRewardStroops: bigint;
  keeperGasFeeStroops: bigint;
  totalCostStroops: bigint;
  totalCostXlm: number;
  archivalRestorationComparison: {
    restorationFeeStroops: bigint;
    savingsStroops: bigint;
    percentSaved: number;
  };
}

export interface TtlExtensionTaskConfig {
  contractAddress: string;
  thresholdLedgers: number;
  extendToLedgers: number;
  keeperRewardStroops: bigint;
  deadlineLedgers: number;
  intervalLedgers: number;
}

export class TtlExtensionManager {
  private currentLedger: number;
  private entries: Map<string, StorageEntry> = new Map();
  private extensionHistory: Array<{
    ledger: number;
    threshold: number;
    extendedTo: number;
    entriesExtended: number;
  }> = [];

  constructor(initialLedger: number = 1000) {
    this.currentLedger = initialLedger;
  }

  public registerEntry(
    key: string,
    data: unknown,
    sizeBytes: number = 128,
    naturalTtlLedgers: number = 100
  ): StorageEntry {
    const entry: StorageEntry = {
      key,
      sizeBytes,
      naturalTtlLedgers,
      currentTtlLedgers: naturalTtlLedgers,
      lastUpdatedLedger: this.currentLedger,
      data,
      isArchived: false,
    };
    this.entries.set(key, entry);
    return entry;
  }

  public getEntry(key: string): StorageEntry {
    const entry = this.entries.get(key);
    if (!entry) {
      throw new Error(`Storage entry "${key}" not found`);
    }
    if (entry.isArchived) {
      throw new Error(`Storage entry "${key}" is ARCHIVED. Restoration required.`);
    }
    return entry;
  }

  public advanceLedgers(count: number): void {
    this.currentLedger += count;
    for (const entry of this.entries.values()) {
      if (!entry.isArchived) {
        entry.currentTtlLedgers -= count;
        if (entry.currentTtlLedgers <= 0) {
          entry.currentTtlLedgers = 0;
          entry.isArchived = true;
        }
      }
    }
  }

  public needsExtension(thresholdLedgers: number): boolean {
    for (const entry of this.entries.values()) {
      if (!entry.isArchived && entry.currentTtlLedgers <= thresholdLedgers) {
        return true;
      }
    }
    return false;
  }

  /**
   * Keeper execution: extends TTL of active entries when remaining TTL <= threshold.
   */
  public executeKeeperExtension(
    thresholdLedgers: number,
    extendToLedgers: number
  ): { extended: boolean; entriesExtended: number; newTtl: number } {
    let count = 0;
    let maxNewTtl = 0;

    for (const entry of this.entries.values()) {
      if (!entry.isArchived && entry.currentTtlLedgers <= thresholdLedgers) {
        entry.currentTtlLedgers = Math.max(entry.currentTtlLedgers, extendToLedgers);
        entry.lastUpdatedLedger = this.currentLedger;
        count++;
        maxNewTtl = Math.max(maxNewTtl, entry.currentTtlLedgers);
      }
    }

    if (count > 0) {
      this.extensionHistory.push({
        ledger: this.currentLedger,
        threshold: thresholdLedgers,
        extendedTo: extendToLedgers,
        entriesExtended: count,
      });
    }

    return {
      extended: count > 0,
      entriesExtended: count,
      newTtl: maxNewTtl,
    };
  }

  public getCurrentLedger(): number {
    return this.currentLedger;
  }

  public getExtensionHistory() {
    return [...this.extensionHistory];
  }

  /**
   * Cost Model for the dApp Owner:
   *
   * 1. Storage Rent (Network Fee):
   *    On Soroban, persistent entry rent is calculated as:
   *    Rent = (entrySizeBytes + keySizeBytes) * ledgersExtended * rentFeeRatePerByteLedger
   *    Where rentFeeRatePerByteLedger ~ 25 Stroops per byte per 10,000 ledgers (approx. 0.0025 stroops/byte/ledger).
   *
   * 2. Keeper Reward:
   *    Incentive set by the owner when registering the task on the Keeper Registry.
   *
   * 3. Transaction Gas Fee:
   *    Gas/invocation fee required for the keeper to execute `extend_ttl()`.
   */
  public static calculateCostModel(
    totalSizeBytes: number,
    ledgersExtended: number,
    keeperRewardStroops: bigint = 50_000n, // 0.005 XLM
    keeperGasFeeStroops: bigint = 15_000n // 0.0015 XLM
  ): OwnerCostEstimate {
    // Soroban Network Rent Rate: ~25 stroops per 10,000 ledgers per byte
    // Formula: (bytes * ledgersExtended * 25) / 10000
    const rentRateNumerator = 25n;
    const rentRateDenominator = 10_000n;

    const bytesBig = BigInt(totalSizeBytes);
    const ledgersBig = BigInt(ledgersExtended);

    const storageRentStroops =
      (bytesBig * ledgersBig * rentRateNumerator) / rentRateDenominator;

    const totalCostStroops =
      storageRentStroops + keeperRewardStroops + keeperGasFeeStroops;
    const totalCostXlm = Number(totalCostStroops) / 10_000_000;

    // Soroban Restoration Cost Comparison:
    // If state expires into archive, restoration costs:
    // Base fee (~100,000 stroops) + restoration rent penalty (~10x standard rent)
    const restorationFeeStroops = 100_000n + storageRentStroops * 10n;
    const savingsStroops = restorationFeeStroops - totalCostStroops;
    const percentSaved =
      Number((savingsStroops * 10000n) / restorationFeeStroops) / 100;

    return {
      storageRentStroops,
      keeperRewardStroops,
      keeperGasFeeStroops,
      totalCostStroops,
      totalCostXlm,
      archivalRestorationComparison: {
        restorationFeeStroops,
        savingsStroops,
        percentSaved,
      },
    };
  }
}
