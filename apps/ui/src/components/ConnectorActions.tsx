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
import { AgentPicker } from './AgentPicker';
import { RenameConnector } from './RenameConnector';

interface ConnectorActionsProps {
  token: string;
  connector: Connector;
  refreshing: boolean;
  onRefresh: () => void;
  onDelete: (id: string) => Promise<void>;
  onChanged: () => void;
  onError: (message: string) => void;
}

export function ConnectorActions(props: ConnectorActionsProps): ReactNode {
  const { token, connector, refreshing, onRefresh, onError } = props;
  const dark = useKitScheme() === 'dark';
  const [busy, setBusy] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [picking, setPicking] = useState(false);
  const signIn = connector.signIn;

  const connect = (): void => {
    setBusy(true);
    const tab = window.open('', '_blank');
    connectConnector(token, connector.id).then(
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
    disconnectConnector(token, connector.id).then(
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
        size="lg"
        extra={[
          {
            label: 'Add to agent',
            onSelect: () => {
              setPicking(true);
            },
          },
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
      <AgentPicker
        token={token}
        connectorId={connector.id}
        connectorName={connector.name}
        open={picking}
        onClose={() => {
          setPicking(false);
        }}
      />
      <RenameConnector
        key={connector.name}
        token={token}
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
