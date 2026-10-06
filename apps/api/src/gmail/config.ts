import { filled } from '@metro-labs/http/workos-token';

export interface GmailConfig {
  clientId: string;
  clientSecret: string;
  grantKey: Buffer;
}

export function readGmailConfig(env: NodeJS.ProcessEnv = process.env): GmailConfig | null {
  if (env.METRO_GMAIL_ENABLED !== 'true') return null;
  const clientId = filled(env.METRO_GMAIL_CLIENT_ID);
  const clientSecret = filled(env.METRO_GMAIL_CLIENT_SECRET);
  const key = env.METRO_GMAIL_GRANT_KEY ?? '';
  if (clientId === null || clientSecret === null || !/^[a-fA-F0-9]{64}$/.test(key)) return null;
  return { clientId, clientSecret, grantKey: Buffer.from(key, 'hex') };
}
