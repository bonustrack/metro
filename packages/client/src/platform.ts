export interface KeyValue {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface Location {
  hash(): string;
  search(): string;
  origin(): string;
  replace(hash: string): void;
  push(hash: string): void;
  clearSearch(query: string): void;
}

interface Platform {
  kv: KeyValue;
  tabKv: KeyValue;
  location: Location;
  apiBase: string;
  signInReturn: (() => string) | null;
  random: (count: number) => Uint8Array;
}

export const HOSTED_API = 'https://api.metro.box';

export function memoryKeyValue(seed: Record<string, string> = {}): KeyValue {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
    removeItem: (key) => {
      map.delete(key);
    },
  };
}

function browserStore(pick: () => Storage | undefined): KeyValue {
  const store = (): Storage | null => {
    try {
      return pick() ?? null;
    } catch {
      return null;
    }
  };
  return {
    getItem: (key) => store()?.getItem(key) ?? null,
    setItem: (key, value) => {
      store()?.setItem(key, value);
    },
    removeItem: (key) => {
      store()?.removeItem(key);
    },
  };
}

const hasWindow = (): boolean => typeof window !== 'undefined' && typeof window.location === 'object';

const browserLocation: Location = {
  hash: () => (hasWindow() ? window.location.hash : ''),
  search: () => (hasWindow() ? window.location.search : ''),
  origin: () => (hasWindow() ? window.location.origin : ''),
  replace: (hash) => {
    if (hasWindow()) window.history.replaceState(null, '', `${window.location.pathname}${hash}`);
  },
  push: (hash) => {
    if (hasWindow()) window.location.hash = hash;
  },
  clearSearch: (query) => {
    if (hasWindow()) window.history.replaceState(null, '', `${window.location.pathname}${query === '' ? '' : `?${query}`}${window.location.hash}`);
  },
};

const current: Platform = {
  kv: browserStore(() => (typeof localStorage === 'undefined' ? undefined : localStorage)),
  tabKv: browserStore(() => (typeof sessionStorage === 'undefined' ? undefined : sessionStorage)),
  location: browserLocation,
  apiBase: HOSTED_API,
  signInReturn: null,
  random: (count) => crypto.getRandomValues(new Uint8Array(count)),
};

export function configurePlatform(changes: Partial<Platform>): void {
  Object.assign(current, changes);
}

export const location = (): Location => current.location;

export const apiBase = (): string => current.apiBase;

export const randomBytes = (count: number): Uint8Array => current.random(count);

export function signInReturnUrl(): string {
  if (current.signInReturn !== null) return current.signInReturn();
  return hasWindow() ? `${window.location.origin}${window.location.pathname}` : '';
}

export function readItem(key: string): string | null {
  try {
    return current.kv.getItem(key);
  } catch {
    return null;
  }
}

export function writeItem(key: string, value: string | null): void {
  try {
    if (value === null) current.kv.removeItem(key);
    else current.kv.setItem(key, value);
  } catch {
    return;
  }
}

export function readTabItem(key: string): string | null {
  try {
    return current.tabKv.getItem(key);
  } catch {
    return null;
  }
}

export function writeTabItem(key: string, value: string | null): void {
  try {
    if (value === null) current.tabKv.removeItem(key);
    else current.tabKv.setItem(key, value);
  } catch {
    return;
  }
}

export function timeoutSignal(ms: number): AbortSignal {
  if (typeof AbortSignal.timeout === 'function') return AbortSignal.timeout(ms);
  const controller = new AbortController();
  setTimeout(() => {
    controller.abort();
  }, ms);
  return controller.signal;
}
