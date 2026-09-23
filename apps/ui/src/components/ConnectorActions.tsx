import { type ReactNode, useState } from 'react';
import { Row } from '@stage-labs/kit/react-native/box';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Button } from './ui.js';
import { type Connector } from '../api/connectors.js';
import { useSignIn } from './connector-signin.js';
import { DeleteConnector } from './DeleteConnector.js';
import { RenameConnector } from './RenameConnector.js';

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
  const [renaming, setRenaming] = useState(false);
  const signIn = connector.signIn;
  const { busy, connect, disconnect } = useSignIn(connector, props.onChanged, onError);

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
        extra={[
          {
            label: 'Rename',
            onSelect: () => {
              setRenaming(true);
            },
          },
          {
            label: refreshing ? 'Checking…' : 'Check',
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
