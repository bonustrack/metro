export interface ConnectorHealth {
  ok: boolean;
  reason: string | null;
  at: string;
}

const seen = new Map<string, ConnectorHealth>();

export function noteHealth(id: string, ok: boolean, reason: string | null = null): void {
  seen.set(id, { ok, reason: ok ? null : reason, at: new Date().toISOString() });
}

export const healthOf = (id: string): ConnectorHealth | null => seen.get(id) ?? null;

export function forgetHealth(id?: string): void {
  if (id === undefined) seen.clear();
  else seen.delete(id);
}
