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
import {
  addToCollection,
  createCollection,
  removeFromCollection,
  type Collection,
} from '../api/collections';
import { queryError, refreshCollections, useCollectionsQuery } from '../api/queries';

const EMPTY =
  'No collections yet. Create one and this connector goes straight into it.';

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
        name={`collection-${id}`}
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
  busy,
  onNew,
  onSave,
}: {
  dark: boolean;
  busy: boolean;
  onNew: () => void;
  onSave: () => void;
}): ReactNode {
  return (
    <Row justify="between" align="center" gap={12} wrap>
      <Button
        color="secondary"
        dark={dark}
        disabled={busy}
        label="New collection"
        onPress={onNew}
      />
      <Button
        color="primary"
        dark={dark}
        loading={busy}
        disabled={busy}
        label="Save"
        onPress={onSave}
      />
    </Row>
  );
}

function PickerBody({
  data,
  error,
  failed,
  chosen,
  busy,
  onToggle,
}: {
  data: Collection[] | undefined;
  error: unknown;
  failed: string | null;
  chosen: string[];
  busy: boolean;
  onToggle: (id: string) => void;
}): ReactNode {
  return (
    <>
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
        {(data ?? []).map((collection) => (
          <PickerRow
            key={collection.id}
            id={collection.id}
            name={collection.name}
            checked={chosen.includes(collection.id)}
            busy={busy}
            onToggle={() => {
              onToggle(collection.id);
            }}
          />
        ))}
      </Col>
    </>
  );
}

interface CollectionPickerProps {
  token: string;
  connectorId: string;
  connectorName: string;
  open: boolean;
  onClose: () => void;
}

function memberIds(collections: Collection[], connectorId: string): string[] {
  return collections
    .filter((c) => c.connectorIds.includes(connectorId))
    .map((c) => c.id);
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
  const [staged, setStaged] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const collections = data ?? [];
  const saved = memberIds(collections, connectorId);
  const chosen = staged ?? saved;

  const close = (): void => {
    setStaged(null);
    setFailed(null);
    onClose();
  };

  const toggle = (id: string): void => {
    setStaged(
      chosen.includes(id) ? chosen.filter((c) => c !== id) : [...chosen, id],
    );
  };

  const save = (): void => {
    if (busy) return;
    const added = chosen.filter((id) => !saved.includes(id));
    const dropped = saved.filter((id) => !chosen.includes(id));
    if (added.length === 0 && dropped.length === 0) {
      close();
      return;
    }
    setBusy(true);
    setFailed(null);
    Promise.all([
      ...added.map((id) => addToCollection(token, id, connectorId)),
      ...dropped.map((id) => removeFromCollection(token, id, connectorId)),
    ])
      .then(() => {
        refreshCollections(client);
        close();
      })
      .catch((err: unknown) => {
        setFailed(queryError(err, 'Could not save those collections.'));
      })
      .finally(() => {
        setBusy(false);
      });
  };

  return (
    <Modal
      title={`Add ${connectorName} to a collection`}
      open={open}
      onClose={close}
    >
      <Col gap={12}>
        <PickerBody
          data={data}
          error={error}
          failed={failed}
          chosen={chosen}
          busy={busy}
          onToggle={toggle}
        />
        <PickerFooter
          dark={dark}
          busy={busy}
          onNew={() => {
            setCreating(true);
          }}
          onSave={save}
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
          refreshCollections(client);
          setStaged([...chosen, made.id]);
          return made;
        }}
      />
    </Modal>
  );
}
