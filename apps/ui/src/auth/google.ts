const GIS_SRC = 'https://accounts.google.com/gsi/client';
const STORAGE_KEY = 'metro.google.credential';
const EXP_SKEW_MS = 60_000;

interface CredentialResponse {
  credential?: string;
}

interface GoogleAccountsId {
  initialize: (config: {
    client_id: string;
    callback: (r: CredentialResponse) => void;
    auto_select?: boolean;
    use_fedcm_for_prompt?: boolean;
  }) => void;
  renderButton: (
    el: HTMLElement,
    options: { theme?: string; size?: string; width?: number; text?: string },
  ) => void;
  prompt: () => void;
  disableAutoSelect: () => void;
}

declare global {
  interface Window {
    google?: { accounts: { id: GoogleAccountsId } };
  }
}

export function googleClientId(): string {
  return import.meta.env.VITE_GOOGLE_CLIENT_ID?.trim() ?? '';
}

export function storedCredential(): string | null {
  try {
    const v = window.localStorage.getItem(STORAGE_KEY);
    return v !== null && v.length > 0 ? v : null;
  } catch {
    return null;
  }
}

export function storeCredential(credential: string): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, credential);
  } catch {
    return;
  }
}

export function clearCredential(): void {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    return;
  }
}

function credentialExpiry(credential: string): number | null {
  const parts = credential.split('.');
  const body = parts[1];
  if (parts.length !== 3 || body === undefined) return null;
  try {
    const payload = JSON.parse(
      atob(body.replace(/-/g, '+').replace(/_/g, '/')),
    ) as { exp?: number };
    return typeof payload.exp === 'number' ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

export function credentialIsFresh(credential: string, now = Date.now()): boolean {
  const exp = credentialExpiry(credential);
  return exp !== null && exp - EXP_SKEW_MS > now;
}

let scriptPromise: Promise<GoogleAccountsId> | null = null;

function loadGis(): Promise<GoogleAccountsId> {
  if (window.google?.accounts.id)
    return Promise.resolve(window.google.accounts.id);
  scriptPromise ??= new Promise<GoogleAccountsId>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(
      `script[src="${GIS_SRC}"]`,
    );
    const onLoad = (): void => {
      if (window.google?.accounts.id) resolve(window.google.accounts.id);
      else reject(new Error('Google Identity Services failed to initialize'));
    };
    const onError = (): void => {
      reject(new Error('failed to load Google Identity Services'));
    };
    if (existing) {
      existing.addEventListener('load', onLoad);
      existing.addEventListener('error', onError);
      return;
    }
    const script = document.createElement('script');
    script.src = GIS_SRC;
    script.async = true;
    script.defer = true;
    script.addEventListener('load', onLoad);
    script.addEventListener('error', onError);
    document.head.appendChild(script);
  });
  return scriptPromise;
}

export async function renderSignIn(
  el: HTMLElement,
  clientId: string,
  onCredential: (credential: string) => void,
): Promise<void> {
  const id = await loadGis();
  id.initialize({
    client_id: clientId,
    callback: (r) => {
      if (r.credential) onCredential(r.credential);
    },
    auto_select: true,
    use_fedcm_for_prompt: true,
  });
  id.renderButton(el, { theme: 'outline', size: 'large', text: 'continue_with' });
  id.prompt();
}

export function signOut(): void {
  clearCredential();
  window.google?.accounts.id.disableAutoSelect();
}
