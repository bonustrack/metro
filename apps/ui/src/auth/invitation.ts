const KEY = 'metro.invitation';
const TOKEN_RE = /^[A-Za-z0-9_-]{8,200}$/;

export function takeInvitationFromUrl(): void {
  const params = new URLSearchParams(window.location.search);
  const token = params.get('invitation_token');
  if (token === null) return;
  if (TOKEN_RE.test(token)) {
    try {
      window.sessionStorage.setItem(KEY, token);
    } catch {
      return;
    }
  }
  window.history.replaceState(null, '', `${window.location.pathname}${window.location.hash === '' ? '#/login' : window.location.hash}`);
}

export function pendingInvitation(): string | null {
  try {
    const token = window.sessionStorage.getItem(KEY);
    return token !== null && TOKEN_RE.test(token) ? token : null;
  } catch {
    return null;
  }
}

export function clearInvitation(): void {
  try {
    window.sessionStorage.removeItem(KEY);
  } catch {
    return;
  }
}
