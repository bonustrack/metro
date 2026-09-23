export const OUTLOOK_CLIENT_ID = 'a2fbd978-97ee-4cc9-92bb-9d9567a7bf40';

export const SCOPES = [
  'https://graph.microsoft.com/Mail.ReadWrite',
  'https://graph.microsoft.com/Mail.Send',
  'https://graph.microsoft.com/User.Read',
  'offline_access',
  'openid',
].join(' ');

export const NOT_SET_UP = 'Outlook is not set up on this Metro yet.';

export const MAILBOX_URL = 'https://outlook.office.com/mail/';

const trimmed = (raw: string | undefined): string => (raw ?? '').trim();

export function clientId(): string {
  const fromEnv = trimmed(process.env.METRO_OUTLOOK_CLIENT_ID);
  return fromEnv === '' ? OUTLOOK_CLIENT_ID : fromEnv;
}

const base = (raw: string | undefined, fallback: string): string => {
  const value = trimmed(raw);
  return (value === '' ? fallback : value).replace(/\/+$/, '');
};

export const loginBase = (): string =>
  base(process.env.METRO_OUTLOOK_LOGIN_URL, 'https://login.microsoftonline.com/common');

export const redirectUri = (): string => {
  const value = trimmed(process.env.METRO_OUTLOOK_REDIRECT);
  return value === '' ? 'https://metro.box/' : value;
};

export const graphBase = (): string =>
  base(process.env.METRO_OUTLOOK_GRAPH_URL, 'https://graph.microsoft.com/v1.0');
