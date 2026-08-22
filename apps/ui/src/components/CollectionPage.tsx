import { type ReactNode, useState } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { useQueryClient } from '@tanstack/react-query';
import { Text } from './ui';
import { SHRINK } from '../theme';
import { PageTitle } from './PageTitle';
import { BackLink } from './BackLink';
import { CountBadge } from './CountBadge';
import { ConnectorFavicon } from './ConnectorFavicon';
import { KebabMenu } from './KebabMenu';
import { NameModal } from './NameModal';
import { Loading } from './Loading';
import { connectorHost, type Connector } from '../api/connectors';
import { deleteCollection, removeFromCollection, renameCollection } from '../api/collections';
import {
  queryError,
  refreshCollections,
  useConnectorsQuery,
  useCollectionQuery,
} from '../api/queries';
import { useDocumentTitle } from '../title';

const ROW_PAD_Y = 10;
const ICON_SIZE = 16;

const EMPTY =
  'Nothing in this collection yet. Open a connector and use Add to collection from its menu.';

function MemberRow({
  connector,
  busy,
  onRemove,
}: {
  connector: Connector;
  busy: boolean;
  onRemove: () => void;
}): ReactNode {
  const palette = useKitPalette();
  return (
    <Row
      justify="between"
      align="center"
      gap={12}
      padding={{ y: ROW_PAD_Y }}
      border={{ bottom: { width: 1, color: palette.border } }}
    >
      <Row gap={10} align="center" flex={1} minWidth={0}>
        <ConnectorFavicon
          name={connector.name}
          url={connector.url}
          size={ICON_SIZE}
        />
        <Text size="md" weight="semibold" numberOfLines={1}>
          {connector.name}
        </Text>
        <Text size="sm" role="secondary" numberOfLines={1} style={SHRINK}>
          {connectorHost(connector.url)}
        </Text>
      </Row>
      <KebabMenu
        label={`Actions for ${connector.name}`}
        size="lg"
        items={[
          {
            label: busy ? 'Removing…' : 'Remove from collection',
            danger: true,
            onSelect: onRemove,
          },
        ]}
      />
    </Row>
  );
}

function CollectionHeading({
  name,
  count,
  onBack,
  onRename,
  onRemove,
}: {
  name: string;
  count: number;
  onBack: () => void;
  onRename: () => void;
  onRemove: () => void;
}): ReactNode {
  return (
    <Col gap={12}>
      <Row justify="between" align="center" gap={12}>
        <BackLink label="Collections" href="#/collections" onPress={onBack} />
        <KebabMenu
          label="Collection actions"
          size="lg"
          items={[
            { label: 'Rename', onSelect: onRename },
            { label: 'Remove', danger: true, onSelect: onRemove },
          ]}
        />
      </Row>
      <Row gap={10} align="center">
        <PageTitle>{name}</PageTitle>
        <CountBadge count={count} beside="title" />
      </Row>
      <Text size="sm" role="secondary">
        Authorize this collection on a machine from the sign-in page. It can read these
        connectors and nothing else on your account.
      </Text>
    </Col>
  );
}

interface CollectionPageProps {
  token: string;
  id: string;
  onBack: () => void;
  onGone: () => void;
}

export function CollectionPage({ token, id, onBack, onGone }: CollectionPageProps): ReactNode {
  const client = useQueryClient();
  const { data, error } = useCollectionQuery(token, id);
  const connectors = useConnectorsQuery(token);
  const [busy, setBusy] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  useDocumentTitle(data?.name ?? 'Collection');

  const reload = (): void => {
    refreshCollections(client, id);
  };

  const drop = (connectorId: string): void => {
    if (busy) return;
    setBusy(true);
    setFailed(null);
    removeFromCollection(token, id, connectorId)
      .then(reload)
      .catch((err: unknown) => {
        setFailed(queryError(err, 'Could not update the collection.'));
      })
      .finally(() => {
        setBusy(false);
      });
  };

  const remove = (): void => {
    deleteCollection(token, id)
      .then(() => {
        refreshCollections(client);
        onGone();
      })
      .catch((err: unknown) => {
        setFailed(queryError(err, 'Could not remove the collection.'));
      });
  };

  if (error !== null) return <Text size="sm" role="danger">{queryError(error, 'Could not load the collection.')}</Text>;
  if (data === undefined) return <Loading />;
  const all = connectors.data?.connectors ?? [];
  const rows = all.filter((row) => data.connectorIds.includes(row.id));

  return (
    <Col gap={20}>
      <CollectionHeading
        name={data.name}
        count={data.connectorIds.length}
        onBack={onBack}
        onRename={() => {
          setRenaming(true);
        }}
        onRemove={remove}
      />
      {failed === null ? null : <Text size="sm" role="danger">{failed}</Text>}
      {rows.length === 0 ? (
        <Text size="sm" role="secondary">
          {EMPTY}
        </Text>
      ) : (
        <Col>
          {rows.map((row) => (
            <MemberRow
              key={row.id}
              connector={row}
              busy={busy}
              onRemove={() => {
                drop(row.id);
              }}
            />
          ))}
        </Col>
      )}
      <NameModal
        key={data.name}
        title="Rename collection"
        action="Rename"
        placeholder={data.name}
        initial={data.name}
        failure="Could not rename the collection."
        open={renaming}
        onClose={() => {
          setRenaming(false);
        }}
        onSubmit={async (name) => {
          const next = await renameCollection(token, id, name);
          reload();
          return next;
        }}
      />
    </Col>
  );
}
