const DAEMON_KEY = 'metro.daemon';
const HOSTED_DAEMON = 'https://mcp.metro.box';
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
const PLAIN_HTTP =
  'Plain http only reaches this computer (127.0.0.1 or localhost); anywhere else the session would cross the network unencrypted. For another machine, forward its port with ssh -L, or put it behind https.';

export type DaemonParse = { base: string } | { error: string };

export function builtInDaemon(): string {
  const configured = import.meta.env.VITE_METRO_MCP_URL?.trim();
  const base =
    configured !== undefined && configured !== '' ? configured : HOSTED_DAEMON;
  try {
    return new URL(base, window.location.origin).origin;
  } catch {
    return HOSTED_DAEMON;
  }
}

function parsed(text: string): URL | null {
  try {
    return new URL(SCHEME.test(text) ? text : `http://${text}`);
  } catch {
    return null;
  }
}

function refusal(url: URL): string | null {
  if (url.username !== '' || url.password !== '')
    return 'The address cannot carry a username or password.';
  if (url.protocol === 'https:') return null;
  if (url.protocol !== 'http:')
    return 'The address must start with http:// or https://.';
  return LOOPBACK.has(url.hostname) ? null : PLAIN_HTTP;
}

export function parseDaemonUrl(raw: string): DaemonParse {
  const text = raw.trim();
  if (text === '')
    return { error: 'Enter the daemon address, like http://127.0.0.1:8420.' };
  const url = parsed(text);
  if (url === null) return { error: 'That is not a valid address.' };
  const refused = refusal(url);
  return refused === null ? { base: url.origin } : { error: refused };
}

export function daemonHost(base: string): string {
  try {
    return new URL(base).host;
  } catch {
    return base;
  }
}

export function storedDaemon(): string | null {
  try {
    const v = window.localStorage.getItem(DAEMON_KEY);
    return v !== null && v.length > 0 ? v : null;
  } catch {
    return null;
  }
}

export function storeDaemon(base: string | null): void {
  try {
    if (base === null) window.localStorage.removeItem(DAEMON_KEY);
    else window.localStorage.setItem(DAEMON_KEY, base);
  } catch {
    return;
  }
}
