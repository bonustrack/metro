import { type ReactNode } from 'react';
import { PROVIDERS } from '@metro-labs/client/api/model';
import { routeHash } from '@metro-labs/client/route';
import { ProviderLogo } from './ProviderLogo.js';
import { Rows } from './ui/Group.js';
import { Item } from './ui/Item.js';
import { ICON_SIZE } from './ui/sizes.js';

export function ProviderChoices(): ReactNode {
  return (
    <Rows>
      {PROVIDERS.map((p) => (
        <Item key={p.id} title={p.label} subtitle={p.blurb} leading={<ProviderLogo provider={p} size={ICON_SIZE.lg} />} href={routeHash({ kind: 'org-model-add', provider: p.id })} />
      ))}
    </Rows>
  );
}
