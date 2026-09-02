"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.KeeperRegistryProvider = void 0;
exports.useKeeperRegistryClient = useKeeperRegistryClient;
const jsx_runtime_1 = require("react/jsx-runtime");
const react_1 = require("react");
const client_1 = require("../client");
const KeeperRegistryContext = (0, react_1.createContext)(null);
/**
 * Context Provider that supplies a shared `KeeperRegistryClient` instance to children React components.
 */
const KeeperRegistryProvider = ({ client, contractId, rpcUrl, networkPassphrase, secretKey, children, }) => {
    const clientInstance = (0, react_1.useMemo)(() => {
        if (client) {
            return client;
        }
        if (!contractId || !rpcUrl || !networkPassphrase) {
            throw new Error("KeeperRegistryProvider requires either a `client` prop or all of (`contractId`, `rpcUrl`, `networkPassphrase`).");
        }
        return new client_1.KeeperRegistryClient({
            contractId,
            rpcUrl,
            networkPassphrase,
            secretKey,
        });
    }, [client, contractId, rpcUrl, networkPassphrase, secretKey]);
    return ((0, jsx_runtime_1.jsx)(KeeperRegistryContext.Provider, { value: clientInstance, children: children }));
};
exports.KeeperRegistryProvider = KeeperRegistryProvider;
/**
 * Custom hook to retrieve the shared `KeeperRegistryClient` instance from context.
 * Throws a clear, actionable error if called outside `<KeeperRegistryProvider>`.
 */
function useKeeperRegistryClient() {
    const client = (0, react_1.useContext)(KeeperRegistryContext);
    if (!client) {
        throw new Error("useKeeperRegistryClient must be used within a <KeeperRegistryProvider>.");
    }
    return client;
}
//# sourceMappingURL=provider.js.map