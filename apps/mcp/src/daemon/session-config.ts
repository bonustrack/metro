export const SESSION_TTL_SEC = 30 * 24 * 3600;
const PREVIEW = /^([a-z0-9-]+--)?metro-ui\.netlify\.app$/;

export function allowedWebHost(host: string): boolean {
  if (host === 'metro.box' || host === 'localhost' || host === '127.0.0.1')
    return true;
  return PREVIEW.test(host);
}

export function validateReturnTo(returnTo: string): boolean {
  let url: URL;
  try {
    url = new URL(returnTo);
  } catch {
    return false;
  }
  const host = url.hostname;
  if (url.protocol === 'http:' && (host === 'localhost' || host === '127.0.0.1'))
    return true;
  if (url.protocol !== 'https:') return false;
  return allowedWebHost(host);
}
