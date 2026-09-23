/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_METRO_MCP_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare const __METRO_COMMIT__: string;
declare const __METRO_COMMIT_TIME__: string;
