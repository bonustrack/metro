import { type ReactNode, useState } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitPalette, useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Text, Button } from './ui';
import { SHRINK } from '../theme';
import { CountBadge } from './CountBadge';
import { NameModal } from './NameModal';
import { opensElsewhere } from './link';
import { useQueryClient } from '@tanstack/react-query';
import { PageTitle } from './PageTitle';
import { Loading } from './Loading';
import { queryError, refreshCollections, useCollectionsQuery } from '../api/queries';
import { useDocumentTitle } from '../title';
import { createCollection, type Collection } from '../api/collections';

const ROW_PAD_Y = 12;

const BLURB =
  'A collection is what you authorize on a machine. metro login asks for one, and that machine can read nothing else.';

function CollectionRow({
  list,
  onOpen,
}: {
  list: Collection;
  onOpen: (id: string) => void;
}): ReactNode {
  const palette = useKitPalette();
  const count = list.connectorIds.length;
  return (
    <Row border={{ bottom: { width: 1, color: palette.border } }}>
      <a
        className="row-link"
        href={`#/collection/${list.id}`}
        onClick={(e) => {
          if (opensElsewhere(e)) return;
          e.preventDefault();
          onOpen(list.id);
        }}
      >
        <Row
          gap={10}
          align="center"
          flex={1}
          minWidth={0}
          padding={{ y: ROW_PAD_Y }}
        >
          <span className="row-title">
            <Text size="lg" weight="semibold" numberOfLines={1}>
              {list.name}
            </Text>
          </span>
          <Text size="sm" role="secondary" numberOfLines={1} style={SHRINK}>
            {`${String(count)} connector${count === 1 ? '' : 's'}`}
          </Text>
        </Row>
      </a>
    </Row>
  );
}

const EMPTY = 'No collections yet. Create one, then add connectors to it from their menus.';

export function Collections({
  token,
  onOpen,
}: {
  token: string;
  onOpen: (id: string) => void;
}): ReactNode {
  const dark = useKitScheme() === 'dark';
  const client = useQueryClient();
  const { data, error } = useCollectionsQuery(token);
  const [adding, setAdding] = useState(false);
  useDocumentTitle('Collections');
  const lists = data ?? [];
  const onChanged = (): void => {
    refreshCollections(client);
  };
  return (
    <Col gap={16}>
      <Row justify="between" align="start" gap={12} wrap>
        <Col gap={8} style={SHRINK}>
          <Row gap={10} align="center">
            <PageTitle>Collections</PageTitle>
            {data === undefined ? null : (
              <CountBadge count={lists.length} beside="title" />
            )}
          </Row>
          <Text size="sm" role="secondary">
            {BLURB}
          </Text>
        </Col>
        <Button
          color="primary"
          dark={dark}
          label="New collection"
          onPress={() => {
            setAdding(true);
          }}
        />
      </Row>
      {error === null ? null : (
        <Text size="sm" role="danger">
          {queryError(error, 'Could not load your collections.')}
        </Text>
      )}
      {data === undefined && error === null ? <Loading /> : null}
      {data !== undefined && lists.length === 0 ? (
        <Text size="sm" role="secondary">
          {EMPTY}
        </Text>
      ) : (
        <Col>
          {lists.map((list) => (
            <CollectionRow key={list.id} list={list} onOpen={onOpen} />
          ))}
        </Col>
      )}
      <NameModal
        title="New collection"
        action="Create"
        placeholder="work"
        failure="Could not create the collection."
        open={adding}
        onClose={() => {
          setAdding(false);
        }}
        onSubmit={async (name) => {
          const made = await createCollection(token, name);
          onChanged();
          return made;
        }}
      />
    </Col>
  );
}
