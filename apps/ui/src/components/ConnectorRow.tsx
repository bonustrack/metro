import { type ReactNode } from 'react';
import { Icon } from '@stage-labs/kit/react-native/icon';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { Tip } from './Tip.js';
import { connectorHost, type Connector } from '../api/connectors.js';
import { ConnectorFavicon } from './ConnectorFavicon.js';
import { ConnectorActions } from './ConnectorActions.js';
import { LIST_ICON_SIZE, ListRow } from './ListRow.js';
import { healthNote } from './connector-signin.js';
import { routeHash } from '../route.js';

interface ConnectorRowProps {
  project: string;
  row: Connector;
  onOpen: (id: string) => void;
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

export function ConnectorRow({ project, row, onOpen, onChanged, onDelete, onError }: ConnectorRowProps): ReactNode {
  const note = healthNote(row);
  return (
    <ListRow
      title={row.name}
      detail={connectorHost(row.url)}
      href={routeHash({ kind: 'connector', project, id: row.id })}
      icon={<ConnectorFavicon name={row.name} url={row.url} size={LIST_ICON_SIZE} />}
      muted={row.signIn === 'disconnected'}
      extra={note === null ? undefined : <HealthWarning note={note} />}
      onOpen={() => {
        onOpen(row.id);
      }}
      trailing={<ConnectorActions connector={row} inRow onDelete={onDelete} onChanged={onChanged} onError={onError} />}
    />
  );
}
