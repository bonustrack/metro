import { parsePublicConnectorUrl } from '@metro-labs/http/connector-public-url';

export function migrationOrigin(raw: unknown): string | null {
  try {
    return parsePublicConnectorUrl(raw).origin;
  } catch {
    return null;
  }
}
