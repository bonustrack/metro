import { type ReactNode, useState } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import {
  useKitPalette,
  useKitScheme,
} from '@stage-labs/kit/react-native/theme-context';
import { useQueryClient } from '@tanstack/react-query';
import { Text, Button } from './ui';
import { SHRINK } from '../theme';
import { PageTitle } from './PageTitle';
import { BackLink } from './BackLink';
import { routeHash } from '../route';
import { CountBadge } from './CountBadge';
import { ConnectorFavicon } from './ConnectorFavicon';
import { KebabMenu } from './KebabMenu';
import { AddConnectors } from './AddConnectors';
import { NameModal } from './NameModal';
import { Loading } from './Loading';
import { connectorHost, type Connector } from '../api/connectors';
import {
  type Collection,
  addToCollection,
  deleteCollection,
  removeFromCollection,
  renameCollection,
} from '../api/collections';
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
  project,
  count,
  dark,
  onBack,
  onAdd,
  onRename,
  onRemove,
}: {
  name: string;
  project: string;
  count: number;
  dark: boolean;
  onBack: () => void;
  onAdd: () => void;
  onRename: () => void;
  onRemove: () => void;
}): ReactNode {
  return (
    <Col gap={12}>
      <Row justify="between" align="center" gap={12}>
        <BackLink
          label="Collections"
          href={routeHash({ kind: 'collections', project })}
          onPress={onBack}
        />
        <Row gap={8} align="center">
          <Button
            color="primary"
            dark={dark}
            label="Add connectors"
            onPress={onAdd}
          />
          <KebabMenu
            label="Collection actions"
            size="lg"
            items={[
              { label: 'Rename', onSelect: onRename },
              { label: 'Remove', danger: true, onSelect: onRemove },
            ]}
          />
        </Row>
      </Row>
      <Row gap={10} align="center">
        <PageTitle>{name}</PageTitle>
        <CountBadge count={count} beside="title" />
      </Row>
    </Col>
  );
}


function CollectionModals({
  token,
  project,
  id,
  data,
  adding,
  renaming,
  onDone,
  reload,
}: {
  token: string;
  project: string;
  id: string;
  data: Collection;
  adding: boolean;
  renaming: boolean;
  onDone: () => void;
  reload: () => void;
}): ReactNode {
  return (
    <>
      <AddConnectors
        key={data.connectorIds.join(',')}
        token={token}
        project={project}
        title={`Connectors in ${data.name}`}
        action="Save"
        initial={data.connectorIds}
        open={adding}
        onClose={onDone}
        onSubmit={async (ids) => {
          const added = ids.filter((c: string) => !data.connectorIds.includes(c));
          const dropped = data.connectorIds.filter((c: string) => !ids.includes(c));
          for (const c of added) await addToCollection(token, id, c);
          for (const c of dropped) await removeFromCollection(token, id, c);
          reload();
        }}
      />
      <NameModal
        key={data.name}
        title="Rename collection"
        action="Rename"
        placeholder={data.name}
        initial={data.name}
        failure="Could not rename the collection."
        open={renaming}
        onClose={onDone}
        onSubmit={async (name) => {
          const next = await renameCollection(token, id, name);
          reload();
          return next;
        }}
      />
    </>
  );
}

interface CollectionPageProps {
  token: string;
  project: string;
  id: string;
  onBack: () => void;
  onGone: () => void;
}

export function CollectionPage({ token,
  project, id, onBack, onGone }: CollectionPageProps): ReactNode {
  const client = useQueryClient();
  const dark = useKitScheme() === 'dark';
  const { data, error } = useCollectionQuery(token, id);
  const connectors = useConnectorsQuery(token, project);
  const [busy, setBusy] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [adding, setAdding] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  useDocumentTitle(data?.name ?? 'Collection');

  const reload = (): void => {
    refreshCollections(client, project, id);
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
        refreshCollections(client, project);
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
        project={project}
        count={data.connectorIds.length}
        dark={dark}
        onAdd={() => {
          setAdding(true);
        }}
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
      <CollectionModals
        token={token}
        project={project}
        id={id}
        data={data}
        adding={adding}
        renaming={renaming}
        onDone={() => {
          setAdding(false);
          setRenaming(false);
        }}
        reload={reload}
      />
    </Col>
  );
}
