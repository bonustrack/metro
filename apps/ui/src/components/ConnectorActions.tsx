import { type ReactNode, useState } from 'react';
import { Row } from '@stage-labs/kit/react-native/box';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Button } from './ui';
import {
  connectConnector,
  disconnectConnector,
  type Connector,
} from '../api/connectors';
import { queryError } from '../api/queries';
import { DeleteConnector } from './DeleteConnector';
import { RenameConnector } from './RenameConnector';

interface ConnectorActionsProps {
  connector: Connector;
  refreshing: boolean;
  onRefresh: () => void;
  onDelete: (id: string) => Promise<void>;
  onChanged: () => void;
  onError: (message: string) => void;
}

export function ConnectorActions(props: ConnectorActionsProps): ReactNode {
  const { connector, refreshing, onRefresh, onError } = props;
  const dark = useKitScheme() === 'dark';
  const [busy, setBusy] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const signIn = connector.signIn;

  const connect = (): void => {
    setBusy(true);
    const tab = window.open('', '_blank');
    connectConnector(connector.id).then(
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
    setBusy(true);
    disconnectConnector(connector.id).then(
      () => {
        setBusy(false);
        props.onChanged();
      },
      (err: unknown) => {
        onError(queryError(err, 'Could not sign the connector out.'));
        setBusy(false);
      },
    );
  };

  return (
    <Row gap={8} align="center">
      {signIn === null ? null : (
        <Button
          color={signIn === 'connected' ? 'secondary' : 'primary'}
          dark={dark}
          onPress={signIn === 'connected' ? disconnect : connect}
          loading={busy}
          disabled={busy}
          label={signIn === 'connected' ? 'Disconnect' : 'Connect'}
        />
      )}
      <DeleteConnector
        connector={connector}
        onDelete={props.onDelete}
        onError={onError}
        extra={[
          {
            label: 'Rename',
            onSelect: () => {
              setRenaming(true);
            },
          },
          {
            label: refreshing ? 'Refreshing…' : 'Refresh tools list',
            onSelect: onRefresh,
          },
          ...(signIn === 'connected'
            ? [{ label: 'Disconnect', danger: true, onSelect: disconnect }]
            : []),
        ]}
      />
      <RenameConnector
        key={connector.name}
        connector={connector}
        open={renaming}
        onClose={() => {
          setRenaming(false);
        }}
        onRenamed={props.onChanged}
      />
    </Row>
  );
}
