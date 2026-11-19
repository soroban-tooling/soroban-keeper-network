import { LogOut, Wallet } from "lucide-react";
import { useWallet } from "./WalletProvider";

export function WalletControl() {
  const { account, connecting, error, wrongNetwork, connect, disconnect } = useWallet();
  return <div className="wallet-control">{account ? <><button title={account} onClick={disconnect}><LogOut />{account.slice(0, 5)}...{account.slice(-4)}</button>{wrongNetwork && <span role="alert">Wallet network does not match the dashboard.</span>}</> : <button disabled={connecting} onClick={() => void connect()}><Wallet />{connecting ? "Connecting" : "Connect wallet"}</button>}{error && <span role="alert">{error}</span>}</div>;
}
