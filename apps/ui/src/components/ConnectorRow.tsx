import { type ReactNode, useState } from 'react';
import { Row } from '@stage-labs/kit/react-native/box';
import {
  useKitPalette,
  useKitScheme,
} from '@stage-labs/kit/react-native/theme-context';
import { Text, Button } from './ui';
import { SHRINK } from '../theme';
import {
  connectConnector,
  connectorHost,
  disconnectConnector,
  type Connector,
} from '../api/connectors';
import { queryError } from '../api/queries';
import { ConnectorFavicon } from './ConnectorFavicon';
import { DeleteConnector } from './DeleteConnector';
import { RenameConnector } from './RenameConnector';
import { opensElsewhere } from './link';

const ROW_PAD_Y = 12;
const ICON_SIZE = 16;
const CENTER_SELF = { alignSelf: 'center' } as const;

interface ConnectorRowProps {
  token: string;
  row: Connector;
  onOpen: (id: string) => void;
  onChanged: () => void;
  onDelete: (id: string) => Promise<void>;
  onError: (message: string) => void;
}

type ActionProps = Omit<ConnectorRowProps, 'onOpen'>;

function RowActions({
  token,
  row,
  onChanged,
  onDelete,
  onError,
}: ActionProps): ReactNode {
  const dark = useKitScheme() === 'dark';
  const [busy, setBusy] = useState(false);
  const [renaming, setRenaming] = useState(false);

  const connect = (): void => {
    if (busy) return;
    setBusy(true);
    const tab = window.open('', '_blank');
    connectConnector(token, row.id).then(
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
    disconnectConnector(token, row.id).then(
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
    <Row align="center" gap={8} padding={{ y: ROW_PAD_Y }}>
      {row.signIn === 'disconnected' ? (
        <Button
          size="md"
          color="secondary"
          style={CENTER_SELF}
          dark={dark}
          label="Connect"
          loading={busy}
          disabled={busy}
          onPress={connect}
        />
      ) : null}
      <DeleteConnector
        connector={row}
        onDelete={onDelete}
        onError={onError}
        size="lg"
        extra={[
          {
            label: 'Rename',
            onSelect: () => {
              setRenaming(true);
            },
          },
          ...(row.signIn === 'connected'
            ? [{ label: 'Disconnect', danger: true, onSelect: disconnect }]
            : []),
        ]}
      />
      <RenameConnector
        key={row.name}
        token={token}
        connector={row}
        open={renaming}
        onClose={() => {
          setRenaming(false);
        }}
        onRenamed={onChanged}
      />
    </Row>
  );
}

export function ConnectorRow({
  onOpen,
  ...actions
}: ConnectorRowProps): ReactNode {
  const palette = useKitPalette();
  const { row } = actions;
  return (
    <Row
      justify="between"
      align="stretch"
      gap={12}
      border={{ bottom: { width: 1, color: palette.border } }}
    >
      <a
        className="row-link"
        href={`#/connector/${row.id}`}
        onClick={(e) => {
          if (opensElsewhere(e)) return;
          e.preventDefault();
          onOpen(row.id);
        }}
      >
        <ConnectorFavicon name={row.name} url={row.url} size={ICON_SIZE} />
        <Row
          gap={10}
          align="center"
          flex={1}
          minWidth={0}
          padding={{ y: ROW_PAD_Y }}
        >
          <span className="row-title">
            <Text
              size="lg"
              weight="semibold"
              role={row.signIn === 'disconnected' ? 'secondary' : 'default'}
              numberOfLines={1}
            >
              {row.name}
            </Text>
          </span>
          <Text size="sm" role="secondary" numberOfLines={1} style={SHRINK}>
            {connectorHost(row.url)}
          </Text>
        </Row>
      </a>
      <RowActions {...actions} />
    </Row>
  );
}
