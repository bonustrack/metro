import { envUrl, envValue } from '@metro-labs/core/stations/oauth';

export const SCOPES = ['https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.send'].join(' ');

export const MAILBOX_URL = 'https://mail.google.com/';

export const authorizeBase = (): string => envUrl('METRO_GMAIL_AUTH_URL', 'https://accounts.google.com/o/oauth2/v2/auth');

export const tokenUrl = (): string => envUrl('METRO_GMAIL_TOKEN_URL', 'https://oauth2.googleapis.com/token');

export const apiBase = (): string => envUrl('METRO_GMAIL_API_URL', 'https://gmail.googleapis.com');

export const redirectUri = (): string => envValue('METRO_GMAIL_REDIRECT', 'https://metro.box/');
