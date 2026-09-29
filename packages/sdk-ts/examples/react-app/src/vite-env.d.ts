/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_NETWORK?: string;
  readonly VITE_REGISTRY_CONTRACT_ID: string;
  readonly VITE_DEMO_SECRET_KEY: string;
}
