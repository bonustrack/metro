import { type ReactNode, useState } from 'react';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Button } from './ui.js';
import { connectConnector, connectorHost, disconnectConnector, type Connector } from '../api/connectors.js';
import { queryError } from '../api/queries.js';
import { ConnectorFavicon } from './ConnectorFavicon.js';
import { DeleteConnector } from './DeleteConnector.js';
import { RenameConnector } from './RenameConnector.js';
import { LIST_ICON_SIZE, ListRow } from './ListRow.js';
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
  const [busy, setBusy] = useState(false);
  const [renaming, setRenaming] = useState(false);

  const connect = (): void => {
    if (busy) return;
    setBusy(true);
    const tab = window.open('', '_blank');
    connectConnector(row.id).then(
      (authorizeUrl) => {
        setBusy(false);
        if (tab === null) window.location.assign(authorizeUrl);
        else tab.location.assign(authorizeUrl);
      },
      (err: unknown) => {
        tab?.close();
        onError(queryError(err, 'Could not start the sign-in.'));
        setBusy(false);
      },
    );
  };

  const disconnect = (): void => {
    if (busy) return;
    setBusy(true);
    disconnectConnector(row.id).then(
      () => {
        setBusy(false);
        onChanged();
      },
      (err: unknown) => {
        onError(queryError(err, 'Could not sign the connector out.'));
        setBusy(false);
      },
    );
  };

  return (
    <>
      {row.signIn === 'disconnected' ? (
        <Button size="md" color="secondary" style={CENTER_SELF} dark={dark} label="Connect" loading={busy} disabled={busy} onPress={connect} />
      ) : null}
      <DeleteConnector
        connector={row}
        onDelete={onDelete}
        onError={onError}
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

export function ConnectorRow({ onOpen, ...actions }: ConnectorRowProps): ReactNode {
  const { row, project } = actions;
  return (
    <ListRow
      title={row.name}
      detail={connectorHost(row.url)}
      href={routeHash({ kind: 'connector', project, id: row.id })}
      icon={<ConnectorFavicon name={row.name} url={row.url} size={LIST_ICON_SIZE} />}
      muted={row.signIn === 'disconnected'}
      onOpen={() => {
        onOpen(row.id);
      }}
      trailing={<RowActions {...actions} />}
    />
  );
}
