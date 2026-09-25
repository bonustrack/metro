import { type ReactNode, useState } from 'react';
import { Row } from '@stage-labs/kit/react-native/box';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Button } from './ui.js';
import { renameConnector, type Connector } from '../api/connectors.js';
import { useSignIn } from './connector-signin.js';
import { type MenuItem } from './Dropdown.js';
import { DeleteMenu } from './DeleteMenu.js';
import { NameModal } from './NameModal.js';

const CENTER_SELF = { alignSelf: 'center' } as const;

interface ConnectorActionsProps {
  connector: Connector;
  inRow?: boolean;
  check?: { busy: boolean; run: () => void };
  onDelete: (id: string) => Promise<void>;
  onChanged: () => void;
  onError: (message: string) => void;
}

function SignInButton({ connector, inRow, busy, connect, disconnect }: { connector: Connector; inRow: boolean; busy: boolean; connect: () => void; disconnect: () => void }): ReactNode {
  const dark = useKitScheme() === 'dark';
  const signIn = connector.signIn;
  if (inRow) {
    if (signIn !== 'disconnected') return null;
    return <Button size="md" color="secondary" style={CENTER_SELF} dark={dark} label="Connect" loading={busy} disabled={busy} onPress={connect} />;
  }
  if (signIn === null) return null;
  const connected = signIn === 'connected';
  return (
    <Button
      color={connected ? 'secondary' : 'primary'}
      dark={dark}
      onPress={connected ? disconnect : connect}
      loading={busy}
      disabled={busy}
      label={connected ? 'Disconnect' : 'Connect'}
    />
  );
}

export function ConnectorActions({ connector, inRow = false, check, onDelete, onChanged, onError }: ConnectorActionsProps): ReactNode {
  const [renaming, setRenaming] = useState(false);
  const { busy, connect, disconnect } = useSignIn(connector, onChanged, onError);
  const items: MenuItem[] = [
    {
      label: 'Rename',
      onSelect: () => {
        setRenaming(true);
      },
    },
    ...(check === undefined ? [] : [{ label: check.busy ? 'Checking…' : 'Check', onSelect: check.run }]),
    ...(connector.signIn === 'connected' ? [{ label: 'Disconnect', danger: true, onSelect: disconnect }] : []),
  ];
  return (
    <Row gap={8} align="center">
      <SignInButton connector={connector} inRow={inRow} busy={busy} connect={connect} disconnect={disconnect} />
      <DeleteMenu
        label="Connector actions"
        items={items}
        item="Remove"
        action="Remove connector"
        title="Remove this connector?"
        lines={[`“${connector.name}” and its sign-in are removed from this machine. Claude Code drops its tools at the next /reload-plugins --force.`]}
        failure="Could not remove the connector."
        run={() => onDelete(connector.id)}
      />
      <NameModal
        key={connector.name}
        title="Rename connector"
        action="Rename"
        placeholder={connector.name}
        initial={connector.name}
        failure="Could not rename the connector."
        open={renaming}
        onClose={() => {
          setRenaming(false);
        }}
        onSubmit={async (name) => {
          const row = await renameConnector(connector.id, name);
          onChanged();
          return row;
        }}
      />
    </Row>
  );
}
