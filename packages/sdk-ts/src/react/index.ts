// Separate entry point (`@soroban-keeper-network/sdk/react`) so consumers
// who don't use React aren't forced to pull in a React dependency — React
// is a peer dependency of this package, not a direct one (see package.json).

export { KeeperRegistryProvider, useKeeperRegistryClient } from "./provider";
export type { KeeperRegistryProviderProps } from "./provider";
export { useTask } from "./useTask";
export type { UseTaskOptions, UseTaskResult } from "./useTask";
export { useTaskEvents } from "./useTaskEvents";
export type { UseTaskEventsOptions, UseTaskEventsResult } from "./useTaskEvents";
