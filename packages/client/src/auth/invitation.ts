import { location, readTabItem, writeTabItem } from '../platform.js';

const KEY = 'metro.invitation';
const TOKEN_RE = /^[A-Za-z0-9_-]{8,200}$/;

export function takeInvitationFromUrl(): void {
  const params = new URLSearchParams(location().search());
  const token = params.get('invitation_token');
  if (token === null) return;
  if (TOKEN_RE.test(token)) writeTabItem(KEY, token);
  location().clearSearch('');
  if (location().hash() === '') location().replace('#/login');
}

export function pendingInvitation(): string | null {
  const token = readTabItem(KEY);
  return token !== null && TOKEN_RE.test(token) ? token : null;
}

export function clearInvitation(): void {
  writeTabItem(KEY, null);
}
