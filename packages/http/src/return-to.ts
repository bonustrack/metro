const PREVIEW = /^([a-z0-9-]+--)?metro-ui\.netlify\.app$/;
const LOCAL = new Set(['localhost', '127.0.0.1']);

export const previewReturns = (env: NodeJS.ProcessEnv = process.env): boolean => env.METRO_PREVIEW_RETURNS?.trim() === '1';

const APP_RETURN = 'metro://auth';

export const isAppReturn = (returnTo: string): boolean => returnTo === APP_RETURN;

function parsed(returnTo: string): URL | null {
  try {
    return new URL(returnTo);
  } catch {
    return null;
  }
}

const isLocal = (url: URL): boolean => (url.protocol === 'http:' || url.protocol === 'https:') && LOCAL.has(url.hostname);

const plainHttps = (url: URL): boolean => url.protocol === 'https:' && url.username === '' && url.password === '' && url.port === '';

export function validateReturnTo(returnTo: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const url = parsed(returnTo);
  if (url === null) return false;
  if (isLocal(url)) return true;
  if (!plainHttps(url)) return false;
  return url.hostname === 'metro.box' || (previewReturns(env) && PREVIEW.test(url.hostname));
}
