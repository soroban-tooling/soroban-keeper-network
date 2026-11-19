import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { DataProvider } from "./data/context";
import "./styles.css";
import { NetworkProvider } from "./config";

ReactDOM.createRoot(document.getElementById("root")!).render(<React.StrictMode><NetworkProvider><DataProvider><App /></DataProvider></NetworkProvider></React.StrictMode>);
