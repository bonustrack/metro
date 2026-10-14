import { boundOAuthResource, parsePublicConnectorUrl } from './connector-public-url.js';

export function grantResource(target: string, raw: unknown): string {
  const transport = parsePublicConnectorUrl(target);
  const resource = parsePublicConnectorUrl(raw);
  if (resource.toString() === transport.toString() && typeof raw === 'string') return raw;
  return boundOAuthResource(target, raw);
}
