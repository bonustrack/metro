import { type ReactNode, useState } from 'react';
import { Icon } from '@stage-labs/kit/react-native/icon';
import { useKitPalette, useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Button } from './ui.js';
import { Tip } from './Tip.js';
import { connectorHost, type Connector } from '../api/connectors.js';
import { ConnectorFavicon } from './ConnectorFavicon.js';
import { DeleteConnector } from './DeleteConnector.js';
import { RenameConnector } from './RenameConnector.js';
import { LIST_ICON_SIZE, ListRow } from './ListRow.js';
import { healthNote, useSignIn } from './connector-signin.js';
import { routeHash } from '../route.js';

const CENTER_SELF = { alignSelf: 'center' } as const;

interface ConnectorRowProps {
  project: string;
  row: Connector;
  onOpen: (id: string) => void;
  onChanged: () => void;
  onDelete: (id: string) => Promise<void>;
  onError: (message: string) => void;
}

type ActionProps = Omit<ConnectorRowProps, 'onOpen'>;

function RowActions({ row, onChanged, onDelete, onError }: ActionProps): ReactNode {
  const dark = useKitScheme() === 'dark';
  const [renaming, setRenaming] = useState(false);
  const { busy, connect, disconnect } = useSignIn(row, onChanged, onError);
  return (
    <>
      {row.signIn === 'disconnected' ? (
        <Button size="md" color="secondary" style={CENTER_SELF} dark={dark} label="Connect" loading={busy} disabled={busy} onPress={connect} />
      ) : null}
      <DeleteConnector
        connector={row}
        onDelete={onDelete}
        extra={[
          {
            label: 'Rename',
            onSelect: () => {
              setRenaming(true);
            },
          },
          ...(row.signIn === 'connected' ? [{ label: 'Disconnect', danger: true, onSelect: disconnect }] : []),
        ]}
      />
      <RenameConnector
        key={row.name}
        connector={row}
        open={renaming}
        onClose={() => {
          setRenaming(false);
        }}
        onRenamed={onChanged}
      />
    </>
  );
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

export function ConnectorRow({ onOpen, ...actions }: ConnectorRowProps): ReactNode {
  const { row, project } = actions;
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
      trailing={<RowActions {...actions} />}
    />
  );
}
