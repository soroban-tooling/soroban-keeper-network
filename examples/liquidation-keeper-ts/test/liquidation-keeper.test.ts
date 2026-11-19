import test from 'node:test';
import assert from 'node:assert/strict';
import { MockLendingProtocol, LiquidationKeeperBot } from '../src/liquidation-keeper.ts';

test('Criterion 1: Detects under-collateralized position and executes liquidation task', async () => {
  const lending = new MockLendingProtocol();
  const keeperAddress = 'GD_KEEPER_BOT_ALPHA';
  const bot = new LiquidationKeeperBot(keeperAddress, lending);

  const borrower = 'GA_BORROWER_BOB';
  // Deposit 100 units @ $10/unit ($1000 collateral), $600 debt, 150% min ratio ($900 required)
  lending.openPosition({
    borrower,
    collateralAmount: 100n,
    debtAmount: 600n,
    collateralPrice: 10n,
    minCollateralRatioBps: 15000,
    isLiquidated: false,
  });

  // Position is healthy initially ($1000 >= $900)
  assert.equal(lending.isLiquidatable(borrower), false);

  // Price of collateral drops to $8 ($800 < $900 required) -> under-collateralized!
  lending.updateCollateralPrice(borrower, 8n);
  assert.equal(lending.isLiquidatable(borrower), true);

  // Mock Keeper Registry
  let taskStatus: 'Pending' | 'Claimed' | 'Executed' = 'Pending';
  let creditedKeeperBalance = 0n;

  const mockRegistry = {
    claimTask: (taskId: bigint, keeper: string) => {
      assert.equal(taskId, 1n);
      assert.equal(keeper, keeperAddress);
      taskStatus = 'Claimed';
      return true;
    },
    executeTask: (taskId: bigint, keeper: string, proof: string) => {
      assert.equal(taskId, 1n);
      assert.equal(keeper, keeperAddress);
      assert.ok(proof.includes('liq_proof_borrower_'));
      taskStatus = 'Executed';
      return true;
    },
    creditReward: (keeper: string, amount: bigint) => {
      assert.equal(keeper, keeperAddress);
      creditedKeeperBalance += amount;
    },
  };

  // Bot processes position
  const result = await bot.processPosition(borrower, mockRegistry, 1n, 750_000n);

  assert.equal(result.liquidated, true);
  assert.equal(result.seizedCollateral, 100n);
  assert.equal(taskStatus, 'Executed');
  assert.equal(creditedKeeperBalance, 750_000n);

  // Position is now marked liquidated
  const updatedPos = lending.getPosition(borrower);
  assert.equal(updatedPos?.isLiquidated, true);
});

test('Criterion 2: Healthy position is not liquidated', async () => {
  const lending = new MockLendingProtocol();
  const keeperAddress = 'GD_KEEPER_BOT_ALPHA';
  const bot = new LiquidationKeeperBot(keeperAddress, lending);

  const borrower = 'GA_HEALTHY_ALICE';
  lending.openPosition({
    borrower,
    collateralAmount: 200n,
    debtAmount: 500n,
    collateralPrice: 10n,
    minCollateralRatioBps: 15000,
    isLiquidated: false,
  });

  let taskClaimed = false;
  const mockRegistry = {
    claimTask: () => {
      taskClaimed = true;
      return true;
    },
    executeTask: () => true,
    creditReward: () => {},
  };

  const result = await bot.processPosition(borrower, mockRegistry, 2n);
  assert.equal(result.liquidated, false);
  assert.equal(taskClaimed, false);
});
