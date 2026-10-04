import { type ReactNode } from 'react';
import { Icon } from './Icon.js';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { Tip } from './Tip.js';
import { connectorHost, type Connector } from '@metro-labs/client/api/connectors';
import { ConnectorFavicon } from './ConnectorFavicon.js';
import { ConnectorActions } from './ConnectorActions.js';
import { LIST_ICON_SIZE, ListRow } from './ListRow.js';
import { healthNote } from './connector-signin.js';
import { routeHash } from '@metro-labs/client/route';

interface ConnectorRowProps {
  project: string;
  row: Connector;
  onChanged: () => void;
  onDelete: (id: string) => Promise<void>;
  onError: (message: string) => void;
}

const WARNING_SIZE = 16;

function HealthWarning({ note }: { note: string }): ReactNode {
  const palette = useKitPalette();
  return (
    <Tip label={note}>
      <Icon name="exclamationCircle" size={WARNING_SIZE} color={palette.danger} />
    </Tip>
  );
}

export function ConnectorRow({ project, row, onChanged, onDelete, onError }: ConnectorRowProps): ReactNode {
  const note = healthNote(row);
  return (
    <ListRow
      title={row.name}
      detail={connectorHost(row.url)}
      href={routeHash({ kind: 'connector', project, id: row.id })}
      icon={<ConnectorFavicon name={row.name} url={row.url} size={LIST_ICON_SIZE} />}
      muted={row.signIn === 'disconnected'}
      extra={note === null ? undefined : <HealthWarning note={note} />}
      trailing={<ConnectorActions connector={row} inRow onDelete={onDelete} onChanged={onChanged} onError={onError} />}
    />
  );
}
