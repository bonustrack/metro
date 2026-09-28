import { envUrl, envValue } from '@metro-labs/core/stations/oauth';

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

export const clientId = (): string => envValue('METRO_OUTLOOK_CLIENT_ID', OUTLOOK_CLIENT_ID);

export const loginBase = (): string => envUrl('METRO_OUTLOOK_LOGIN_URL', 'https://login.microsoftonline.com/common');

export const redirectUri = (): string => envValue('METRO_OUTLOOK_REDIRECT', 'https://metro.box/');

export const graphBase = (): string => envUrl('METRO_OUTLOOK_GRAPH_URL', 'https://graph.microsoft.com/v1.0');
