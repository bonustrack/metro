const ADDRESS_RE = /^0x[0-9a-f]{40}$/;

export function normalizeAddress(raw: string): string | null {
  const address = raw.trim().toLowerCase();
  return ADDRESS_RE.test(address) ? address : null;
}
