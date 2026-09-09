export interface ServerEntry {
  id: string;
  host: string;
  name: string | null;
  addedAt: string;
}

const HOST_RE = /^[a-z0-9][a-z0-9.-]*(?::\d{1,5})?$/;
const HOST_MAX = 253;
const NAME_MAX = 40;

export function parseServerHost(raw: string): string | null {
  const host = raw.trim().toLowerCase();
  return host.length <= HOST_MAX && HOST_RE.test(host) ? host : null;
}

export function parseServerName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const name = raw.replace(/[\p{Cc}]/gu, '').trim().slice(0, NAME_MAX);
  return name === '' ? null : name;
}
