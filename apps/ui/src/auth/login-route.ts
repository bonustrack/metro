const LOGIN_HASH = '#/login';

const LOGIN_ROUTE = '/login';
const STORE_KEY = 'metro.redirect';

function hashParts(): { route: string; query: URLSearchParams } {
  const raw = window.location.hash.replace(/^#/, '');
  const cut = raw.indexOf('?');
  const route = cut === -1 ? raw : raw.slice(0, cut);
  return {
    route,
    query: new URLSearchParams(cut === -1 ? '' : raw.slice(cut + 1)),
  };
}

export function atLogin(): boolean {
  return hashParts().route === LOGIN_ROUTE;
}

function safeRedirect(raw: string | null): string | null {
  if (raw === null || raw === '' || raw === '/') return null;
  if (!raw.startsWith('/') || raw.startsWith('//')) return null;
  if (raw === LOGIN_ROUTE) return null;
  return raw;
}

function readStored(): string | null {
  try {
    return safeRedirect(window.sessionStorage.getItem(STORE_KEY));
  } catch {
    return null;
  }
}

function writeStored(target: string | null): void {
  try {
    if (target === null) window.sessionStorage.removeItem(STORE_KEY);
    else window.sessionStorage.setItem(STORE_KEY, target);
  } catch {
    return;
  }
}

function replaceHash(hash: string): void {
  window.history.replaceState(null, '', `${window.location.pathname}${hash}`);
}

export function goToLogin(): void {
  if (atLogin()) {
    writeStored(safeRedirect(hashParts().query.get('redirect')));
    return;
  }
  const from = safeRedirect(hashParts().route);
  writeStored(from);
  const query = from === null ? '' : `?redirect=${encodeURIComponent(from)}`;
  replaceHash(`${LOGIN_HASH}${query}`);
}

export function leaveLogin(): void {
  const here = atLogin();
  const target = (here ? safeRedirect(hashParts().query.get('redirect')) : null) ?? readStored();
  if (target === null && !here) return;
  writeStored(null);
  replaceHash(`#${target ?? '/'}`);
}
