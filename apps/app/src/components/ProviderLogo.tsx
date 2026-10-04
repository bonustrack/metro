import { type ReactNode } from 'react';
import { ConnectorFavicon } from './ConnectorFavicon.js';
import { type ProviderInfo } from '@metro-labs/client/api/model';

export function ProviderLogo({ provider, size }: { provider: ProviderInfo | undefined; size: number }): ReactNode {
  if (provider === undefined) return null;
  return <ConnectorFavicon name={provider.label} url={provider.site} size={size} />;
}
