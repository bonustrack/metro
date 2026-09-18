import { type ReactNode } from 'react';
import { ConnectorFavicon } from './ConnectorFavicon.js';
import { type ProviderInfo } from '../api/model.js';

export function ProviderLogo({ provider, size }: { provider: ProviderInfo | undefined; size: number }): ReactNode {
  if (provider === undefined) return null;
  return <ConnectorFavicon name={provider.label} url={provider.site} size={size} />;
}
