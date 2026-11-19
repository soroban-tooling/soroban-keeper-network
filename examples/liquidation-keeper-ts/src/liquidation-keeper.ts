export interface BorrowerPosition {
  borrower: string;
  collateralAmount: bigint;
  debtAmount: bigint;
  collateralPrice: bigint;
  minCollateralRatioBps: number; // e.g. 15000 = 150%
  isLiquidated: boolean;
}

export interface TaskRecord {
  id: bigint;
  targetAddress: string;
  taskType: 'Liquidation';
  status: 'Pending' | 'Claimed' | 'Executed';
  claimedBy?: string;
}

export class MockLendingProtocol {
  private positions = new Map<string, BorrowerPosition>();

  openPosition(position: BorrowerPosition): void {
    this.positions.set(position.borrower, { ...position });
  }

  updateCollateralPrice(borrower: string, newPrice: bigint): void {
    const pos = this.positions.get(borrower);
    if (!pos) throw new Error(`Position not found for ${borrower}`);
    pos.collateralPrice = newPrice;
  }

  isLiquidatable(borrower: string): boolean {
    const pos = this.positions.get(borrower);
    if (!pos || pos.isLiquidated) return false;

    const collateralValue = pos.collateralAmount * pos.collateralPrice;
    const requiredValue = (pos.debtAmount * BigInt(pos.minCollateralRatioBps)) / 10_000n;

    return collateralValue < requiredValue;
  }

  liquidate(liquidator: string, borrower: string): bigint {
    const pos = this.positions.get(borrower);
    if (!pos) throw new Error(`Position not found for ${borrower}`);
    if (pos.isLiquidated) throw new Error('Position already liquidated');

    if (!this.isLiquidatable(borrower)) {
      throw new Error('Position is healthy; liquidation rejected');
    }

    const seized = pos.collateralAmount;
    pos.isLiquidated = true;
    pos.collateralAmount = 0n;
    pos.debtAmount = 0n;
    return seized;
  }

  getPosition(borrower: string): BorrowerPosition | undefined {
    return this.positions.get(borrower);
  }
}

export class LiquidationKeeperBot {
  readonly keeperAddress: string;
  readonly lending: MockLendingProtocol;

  constructor(keeperAddress: string, lending: MockLendingProtocol) {
    this.keeperAddress = keeperAddress;
    this.lending = lending;
  }

  /**
   * Evaluates a borrower position and, if under-collateralized, executes liquidation
   * and completes the keeper task lifecycle.
   */
  async processPosition(
    borrower: string,
    registry: {
      claimTask: (taskId: bigint, keeper: string) => boolean;
      executeTask: (taskId: bigint, keeper: string, proof: string) => boolean;
      creditReward: (keeper: string, amount: bigint) => void;
    },
    taskId: bigint,
    rewardAmount: bigint = 500_000n,
  ): Promise<{ liquidated: boolean; seizedCollateral?: bigint; executionProof?: string }> {
    // 1. Check if position is under-collateralized
    if (!this.lending.isLiquidatable(borrower)) {
      return { liquidated: false };
    }

    // 2. Claim the liquidation task in the registry
    const claimSuccess = registry.claimTask(taskId, this.keeperAddress);
    if (!claimSuccess) {
      throw new Error(`Failed to claim liquidation task #${taskId}`);
    }

    // 3. Execute liquidation against lending contract
    const seizedCollateral = this.lending.liquidate(this.keeperAddress, borrower);

    // 4. Submit execution proof to registry
    const executionProof = `liq_proof_borrower_${borrower}_seized_${seizedCollateral}`;
    const executeSuccess = registry.executeTask(taskId, this.keeperAddress, executionProof);
    if (!executeSuccess) {
      throw new Error(`Failed to execute liquidation task #${taskId}`);
    }

    // 5. Accrue keeper reward
    registry.creditReward(this.keeperAddress, rewardAmount);

    return {
      liquidated: true,
      seizedCollateral,
      executionProof,
    };
  }
}
