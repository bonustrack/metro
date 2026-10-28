import { siteDomain } from '@metro-labs/core/favicon';
import { apiBase } from '../platform.js';

export function siteIconUrl(url: string): string {
  const site = siteDomain(url);
  return site === '' ? '' : `${apiBase()}/api/icons?site=${encodeURIComponent(site)}`;
}
