import { apiBase } from '../platform.js';

function hostOf(url: string): string {
  try {
    const { host, hostname } = new URL(url);
    return hostname.includes('.') ? host.toLowerCase() : '';
  } catch {
    return '';
  }
}

export function siteIconUrl(url: string): string {
  const host = hostOf(url);
  return host === '' ? '' : `${apiBase()}/api/icons?host=${encodeURIComponent(host)}`;
}
