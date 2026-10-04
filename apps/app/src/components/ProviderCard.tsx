import { type ReactNode } from 'react';
import { KebabMenu } from './KebabMenu.js';
import { ProviderLogo } from './ProviderLogo.js';
import { LIST_ICON_SIZE, ListRow } from './ListRow.js';
import { CardUsage } from './AgentModel.js';
import type { MenuItem } from './Dropdown.js';
import { PROVIDERS, type ConnectionRow, type ModelSettings } from '@metro-labs/client/api/model';
import { connectionDetail } from '@metro-labs/client/api/providers';
import { useAccountOf } from '../lib/queries.js';
import { Tag } from './Tag.js';


export function connectionNote(conn: ConnectionRow, account: string | null): string {
  if (conn.provider === 'openrouter') return conn.hasKey ? 'API key stored' : 'no key';
  if (account === null) return connectionDetail(conn);
  const plan = conn.plan === null ? '' : ` (${conn.plan})`;
  return conn.provider === 'anthropic' && !conn.hasKey && !conn.signedIn ? `Claude Code login of the server · ${account}` : `${account}${plan}`;
}

export function mostUsed(settings: ModelSettings, id: string): number | null {
  const windows = settings.usage[id]?.windows ?? [];
  return windows.reduce<number | null>((most, w) => (w.used === null ? most : Math.max(most ?? 0, w.used)), null);
}

export function roleOf(settings: ModelSettings, id: string): string {
  if (settings.route === id) return 'Primary';
  const at = (settings.fallbacks ?? []).findIndex((f) => f.connection === id);
  return at === -1 ? 'Not used' : `Fallback ${String(at + 1)}`;
}

interface ConnectionItemProps {
  connection: ConnectionRow;
  settings: ModelSettings;
  items: MenuItem[];
  onOpen: () => void;
}

export function ConnectionItem({ connection, settings, items, onOpen }: ConnectionItemProps): ReactNode {
  const note = [connectionNote(connection, useAccountOf(connection)), roleOf(settings, connection.id)].filter((part) => part !== '').join(' · ');
  const usage = settings.usage[connection.id];
  return (
    <ListRow
      title={connection.label}
      detail={note}
      icon={<ProviderLogo provider={PROVIDERS.find((p) => p.id === connection.provider)} size={LIST_ICON_SIZE} />}
      extra={connection.provider === 'openrouter' && connection.zdr ? <Tag label="Zero data retention" /> : undefined}
      below={usage === undefined ? undefined : <CardUsage usage={usage} />}
      onPress={onOpen}
      trailing={<KebabMenu label={`${connection.label} menu`} items={items} />}
    />
  );
}
