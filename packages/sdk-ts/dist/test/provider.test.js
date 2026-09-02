"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const jsx_runtime_1 = require("react/jsx-runtime");
const node_test_1 = __importDefault(require("node:test"));
const strict_1 = __importDefault(require("node:assert/strict"));
const server_1 = require("react-dom/server");
const stellar_sdk_1 = require("@stellar/stellar-sdk");
const client_1 = require("../src/client");
const provider_1 = require("../src/react/provider");
const dummyContractId = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";
const networkPassphrase = stellar_sdk_1.Networks.TESTNET;
const rpcUrl = "https://soroban-testnet.stellar.org";
(0, node_test_1.default)("useKeeperRegistryClient throws a clear actionable error when used outside KeeperRegistryProvider", () => {
    function OutOfBoundsComponent() {
        (0, provider_1.useKeeperRegistryClient)();
        return null;
    }
    strict_1.default.throws(() => {
        (0, server_1.renderToString)((0, jsx_runtime_1.jsx)(OutOfBoundsComponent, {}));
    }, (err) => {
        return (err instanceof Error &&
            err.message.includes("useKeeperRegistryClient must be used within a <KeeperRegistryProvider>."));
    });
});
(0, node_test_1.default)("KeeperRegistryProvider provides client instance to context consumers", () => {
    const customClient = new client_1.KeeperRegistryClient({
        contractId: dummyContractId,
        rpcUrl,
        networkPassphrase,
    });
    let capturedClient = null;
    function ConsumerComponent() {
        const client = (0, provider_1.useKeeperRegistryClient)();
        capturedClient = client;
        return (0, jsx_runtime_1.jsx)("div", { children: client.contractId });
    }
    const html = (0, server_1.renderToString)((0, jsx_runtime_1.jsx)(provider_1.KeeperRegistryProvider, { client: customClient, children: (0, jsx_runtime_1.jsx)(ConsumerComponent, {}) }));
    strict_1.default.ok(html.includes(dummyContractId));
    strict_1.default.equal(capturedClient, customClient);
});
(0, node_test_1.default)("KeeperRegistryProvider constructs client automatically from config props", () => {
    let capturedClient = null;
    function ConsumerComponent() {
        const client = (0, provider_1.useKeeperRegistryClient)();
        capturedClient = client;
        return (0, jsx_runtime_1.jsx)("div", { children: client.contractId });
    }
    const html = (0, server_1.renderToString)((0, jsx_runtime_1.jsx)(provider_1.KeeperRegistryProvider, { contractId: dummyContractId, rpcUrl: rpcUrl, networkPassphrase: networkPassphrase, children: (0, jsx_runtime_1.jsx)(ConsumerComponent, {}) }));
    strict_1.default.ok(html.includes(dummyContractId));
    strict_1.default.ok(capturedClient !== null);
    strict_1.default.equal(capturedClient.contractId, dummyContractId);
    strict_1.default.equal(capturedClient.rpcUrl, rpcUrl);
});
(0, node_test_1.default)("KeeperRegistryProvider throws error if required config props are missing when client is not passed", () => {
    function ConsumerComponent() {
        (0, provider_1.useKeeperRegistryClient)();
        return null;
    }
    strict_1.default.throws(() => {
        (0, server_1.renderToString)(
        // @ts-ignore
        (0, jsx_runtime_1.jsx)(provider_1.KeeperRegistryProvider, { contractId: dummyContractId, children: (0, jsx_runtime_1.jsx)(ConsumerComponent, {}) }));
    }, /KeeperRegistryProvider requires either a `client` prop or all of/);
});
//# sourceMappingURL=provider.test.js.map