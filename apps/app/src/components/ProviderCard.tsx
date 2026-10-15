import { type ReactNode } from 'react';
import { ProviderLogo } from './ProviderLogo.js';
import { LIST_ICON_SIZE, ListRow } from './ListRow.js';
import type { ConnectionRow } from '@metro-labs/client/api/model';
import { connectionDetail, providerInfo, usesSessionLogin } from '@metro-labs/client/api/providers';
import { Tag } from './Tag.js';

export function connectionNote(conn: ConnectionRow, account: string | null): string {
  if (account === null || conn.signedOut || conn.provider === 'openrouter' || conn.provider === 'bedrock') return connectionDetail(conn);
  if (usesSessionLogin(conn)) return `the login Claude Code is signed in with · ${account}`;
  return `${account}${conn.plan === null ? '' : ` (${conn.plan})`}`;
}

interface ConnectionItemProps {
  connection: ConnectionRow;
  detail: string;
  trailing?: ReactNode;
  onOpen?: () => void;
}

export function ConnectionItem({ connection, detail, trailing, onOpen }: ConnectionItemProps): ReactNode {
  return (
    <ListRow
      title={connection.label}
      detail={detail}
      icon={<ProviderLogo provider={providerInfo(connection.provider)} size={LIST_ICON_SIZE} />}
      muted={connection.signedOut}
      extra={connection.signedOut ? <Tag label="Signed out" /> : connection.provider === 'openrouter' && connection.zdr ? <Tag label="Zero data retention" /> : undefined}
      onPress={onOpen}
      trailing={trailing}
    />
  );
}
