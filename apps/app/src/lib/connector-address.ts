const GENERIC = new Set(['mcp', 'api', 'www', 'app', 'server', 'servers', 'remote', 'connect', 'gateway']);

export function nameFromAddress(address: string): string {
  let host: string;
  try {
    host = new URL(address.trim()).hostname;
  } catch {
    return '';
  }
  const labels = host.split('.').filter((label) => label !== '');
  const named = labels.slice(0, labels.length > 1 ? -1 : undefined).filter((label) => !GENERIC.has(label.toLowerCase()));
  const pick = named.at(-1) ?? labels[0] ?? '';
  return pick === '' ? '' : `${pick.slice(0, 1).toUpperCase()}${pick.slice(1)}`;
}

export function addressProblem(address: string): string | null {
  const text = address.trim();
  if (text === '') return 'Paste the address first.';
  try {
    const url = new URL(text);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return 'Use a web address that starts with https://.';
    return url.hostname === '' ? 'That address has no server name.' : null;
  } catch {
    return 'Use a full address that starts with https://.';
  }
}
