export interface VaultEntry {
  id: string;
  name: string;
  stations: string[];
  syncedAt: string;
}

export interface VaultBundle extends VaultEntry {
  envelope: Record<string, unknown>;
}

export const ENVELOPE_MAX = 2 * 1024 * 1024;
