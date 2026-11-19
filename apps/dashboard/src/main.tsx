import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import "./styles.css";
import { NetworkProvider } from "./config";
import { WalletProvider } from "./wallet/WalletProvider";

ReactDOM.createRoot(document.getElementById("root")!).render(<React.StrictMode><NetworkProvider><WalletProvider><App /></WalletProvider></NetworkProvider></React.StrictMode>);
