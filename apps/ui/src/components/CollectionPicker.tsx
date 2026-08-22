import { type ReactNode, useState } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { Checkbox } from '@stage-labs/kit/react-native/checkbox';
import { Pressable } from '@stage-labs/kit/react-native/pressable';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { useQueryClient } from '@tanstack/react-query';
import { Text, Button } from './ui';
import { SHRINK } from '../theme';
import { Modal } from './Modal';
import { NameModal } from './NameModal';
import { Loading } from './Loading';
import { addToCollection, createCollection, removeFromCollection } from '../api/collections';
import { queryError, refreshCollections, useCollectionsQuery } from '../api/queries';

const EMPTY = 'No collections yet. Create one and this connector goes straight into it.';

function PickerRow({
  name,
  checked,
  busy,
  id,
  onToggle,
}: {
  name: string;
  checked: boolean;
  busy: boolean;
  id: string;
  onToggle: () => void;
}): ReactNode {
  const dark = useKitScheme() === 'dark';
  return (
    <Row gap={10} align="center">
      <Checkbox
        name={`list-${id}`}
        checked={checked}
        disabled={busy}
        dark={dark}
        onChange={onToggle}
      />
      <Pressable
        pressedOpacity={0.6}
        disabled={busy}
        onPress={onToggle}
        style={SHRINK}
      >
        <Text size="md" numberOfLines={1}>
          {name}
        </Text>
      </Pressable>
    </Row>
  );
}

function PickerFooter({
  dark,
  onNew,
  onDone,
}: {
  dark: boolean;
  onNew: () => void;
  onDone: () => void;
}): ReactNode {
  return (
    <Row justify="between" align="center" gap={12} wrap>
      <Button size="sm" color="secondary" dark={dark} label="New collection" onPress={onNew} />
      <Button size="sm" color="primary" dark={dark} label="Done" onPress={onDone} />
    </Row>
  );
}

interface CollectionPickerProps {
  token: string;
  connectorId: string;
  connectorName: string;
  open: boolean;
  onClose: () => void;
}

export function CollectionPicker({
  token,
  connectorId,
  connectorName,
  open,
  onClose,
}: CollectionPickerProps): ReactNode {
  const dark = useKitScheme() === 'dark';
  const client = useQueryClient();
  const { data, error } = useCollectionsQuery(token);
  const [busy, setBusy] = useState('');
  const [failed, setFailed] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const reload = (): void => {
    refreshCollections(client);
  };

  const toggle = (collectionId: string, inList: boolean): void => {
    if (busy !== '') return;
    setBusy(collectionId);
    setFailed(null);
    const work = inList
      ? removeFromCollection(token, collectionId, connectorId)
      : addToCollection(token, collectionId, connectorId);
    work
      .then(() => {
        reload();
      })
      .catch((err: unknown) => {
        setFailed(queryError(err, 'Could not update that collection.'));
      })
      .finally(() => {
        setBusy('');
      });
  };

  return (
    <Modal title={`Add ${connectorName} to a collection`} open={open} onClose={onClose}>
      <Col gap={12}>
        {error === null ? null : (
          <Text size="sm" role="danger">
            {queryError(error, 'Could not load your collections.')}
          </Text>
        )}
        {failed === null ? null : (
          <Text size="sm" role="danger">
            {failed}
          </Text>
        )}
        {data === undefined && error === null ? <Loading /> : null}
        {data?.length === 0 ? (
          <Text size="sm" role="secondary">
            {EMPTY}
          </Text>
        ) : null}
        <Col gap={10}>
          {(data ?? []).map((list) => (
            <PickerRow
              key={list.id}
              id={list.id}
              name={list.name}
              checked={list.connectorIds.includes(connectorId)}
              busy={busy !== ''}
              onToggle={() => {
                toggle(list.id, list.connectorIds.includes(connectorId));
              }}
            />
          ))}
        </Col>
        <PickerFooter
          dark={dark}
          onNew={() => {
            setCreating(true);
          }}
          onDone={onClose}
        />
      </Col>
      <NameModal
        title="New collection"
        action="Create"
        placeholder="work"
        failure="Could not create the collection."
        open={creating}
        onClose={() => {
          setCreating(false);
        }}
        onSubmit={async (name) => {
          const made = await createCollection(token, name);
          await addToCollection(token, made.id, connectorId);
          reload();
          return made;
        }}
      />
    </Modal>
  );
}
