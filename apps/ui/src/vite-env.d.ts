/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_METRO_MCP_URL?: string;
  readonly VITE_WC_PROJECT_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
