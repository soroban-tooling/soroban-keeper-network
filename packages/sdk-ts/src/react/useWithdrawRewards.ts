const balance = useKeeperBalance(address);

const withdrawal = useWithdrawRewards();

const handleWithdraw = async () => {
  await withdrawal.withdrawRewards();
  await balance.refetch();
};
