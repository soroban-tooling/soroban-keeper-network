import { BarChart3, Gauge, ListChecks, Menu, PlusCircle, ShieldCheck, X } from "lucide-react";
import { useState } from "react";
import { NavLink, Outlet } from "react-router-dom";
import { useNetwork, type NetworkName } from "../config";
import { WalletControl } from "../wallet/WalletControl";

const links = [
  { to: "/tasks", label: "Tasks", icon: ListChecks },
  { to: "/keepers", label: "Keepers", icon: ShieldCheck },
  { to: "/stats", label: "Stats", icon: BarChart3 },
  { to: "/register", label: "Register task", icon: PlusCircle },
];

export function Shell() {
  const [open, setOpen] = useState(false);
  const { network, selectNetwork } = useNetwork();
  return <div className="app-shell">
    <aside className={open ? "sidebar sidebar-open" : "sidebar"}>
      <div className="brand"><Gauge aria-hidden="true" /><span><strong>Soroban Keeper</strong><small>Network operations</small></span></div>
      <nav aria-label="Primary navigation">{links.map(({ to, label, icon: Icon }) => <NavLink key={to} to={to} onClick={() => setOpen(false)}><Icon aria-hidden="true" />{label}</NavLink>)}</nav>
      <WalletControl />
      <div className={`network-mark network-${network.name}`}><span className="network-dot" /><label><span>Active network</span><select value={network.name} onChange={(event) => selectNetwork(event.target.value as NetworkName)}><option value="testnet">Testnet</option><option value="mainnet">Mainnet</option></select></label></div>
    </aside>
    <main>
      <header className="mobile-header"><button className="icon-button" aria-label={open ? "Close navigation" : "Open navigation"} onClick={() => setOpen((value) => !value)}>{open ? <X /> : <Menu />}</button><span>Soroban Keeper</span></header>
      <Outlet />
    </main>
  </div>;
}
