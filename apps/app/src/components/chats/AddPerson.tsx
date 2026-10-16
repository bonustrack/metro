import { type ReactNode, useEffect, useState } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { Button } from '@stage-labs/kit/react-native/button';
import { Text } from '@stage-labs/kit/react-native/text';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { fetchRecentSenders, lookupSender, type RecentSender } from '@metro-labs/client/api/attach';
import { FormField } from '../FormField.js';
import { Modal } from '../Modal.js';
import { LOOKUP, PLACEHOLDER, WHERE_TO_FIND } from './people-text.js';
import { suggestionsOf } from '../../lib/channel-people.js';
import { queryError } from '../../lib/queries.js';
import { GROW } from '../../lib/style.js';

const NO_INPUT = { autoComplete: 'off', autoCapitalize: 'none', autoCorrect: false, spellCheck: false } as const;

interface Where {
  agentId: string;
  station: string;
  accountId: string;
}

interface LookupProps extends Where {
  busy: boolean;
  onFound: (id: string) => void;
  onError: (message: string | null) => void;
}

function Lookup({ agentId, station, accountId, busy, onFound, onError }: LookupProps): ReactNode {
  const dark = useKitScheme() === 'dark';
  const [draft, setDraft] = useState('');
  const [looking, setLooking] = useState(false);
  const text = LOOKUP[station];
  if (text === undefined) return null;
  const run = (): void => {
    const query = draft.trim();
    if (query === '' || looking || busy) return;
    setLooking(true);
    onError(null);
    lookupSender(agentId, station, accountId, query)
      .then((result) => {
        if (result.id === null) {
          onError(text.notFound);
          return;
        }
        setDraft('');
        onFound(result.id);
      })
      .catch((err: unknown) => {
        onError(queryError(err, text.failed));
      })
      .finally(() => {
        setLooking(false);
      });
  };
  return (
    <Col gap={8}>
      <Text size="xs" role="secondary">
        {text.hint}
      </Text>
      <Row gap={8} align="center" wrap>
        <FormField label="Find someone" name="sender-lookup" value={draft} placeholder={text.placeholder} disabled={busy || looking} dark={dark} inputProps={NO_INPUT} onChangeText={setDraft} onSubmit={run} style={GROW} />
        <Button size="md" color="secondary" dark={dark} disabled={busy || looking || draft.trim() === ''} label={looking ? 'Looking…' : 'Look up'} onPress={run} />
      </Row>
    </Col>
  );
}

function Suggestions({ senders, busy, onAdd }: { senders: RecentSender[]; busy: boolean; onAdd: (id: string) => void }): ReactNode {
  const dark = useKitScheme() === 'dark';
  if (senders.length === 0) return null;
  return (
    <Col gap={8}>
      <Text size="xs" role="secondary">
        Wrote recently
      </Text>
      <Row gap={8} wrap>
        {senders.map((sender) => (
          <Button
            key={sender.id}
            size="md"
            color="secondary"
            dark={dark}
            disabled={busy}
            label={`+ ${sender.name === '' ? sender.id : sender.name}`}
            onPress={() => {
              onAdd(sender.id);
            }}
          />
        ))}
      </Row>
    </Col>
  );
}

interface AddPersonProps extends Where {
  entries: string[];
  busy: boolean;
  error: string | null;
  onAdd: (id: string) => void;
  onError: (message: string | null) => void;
  onClose: () => void;
}

export function AddPerson({ agentId, station, accountId, entries, busy, error, onAdd, onError, onClose }: AddPersonProps): ReactNode {
  const dark = useKitScheme() === 'dark';
  const [draft, setDraft] = useState('');
  const [seen, setSeen] = useState<RecentSender[]>([]);
  useEffect(() => {
    fetchRecentSenders(agentId, station, accountId)
      .then(setSeen)
      .catch(() => undefined);
  }, [agentId, station, accountId]);
  const submit = (): void => {
    if (draft.trim() !== '') onAdd(draft);
  };
  return (
    <Modal title="Add a person" open onClose={onClose}>
      <Col gap={20}>
        <Col gap={8}>
          <Row gap={8} align="center" wrap>
            <FormField label="Their id" name="sender" value={draft} placeholder={PLACEHOLDER[station] ?? 'Sender id'} disabled={busy} dark={dark} inputProps={NO_INPUT} onChangeText={setDraft} onSubmit={submit} style={GROW} />
            <Button size="md" color="primary" dark={dark} disabled={busy || draft.trim() === ''} loading={busy} label="Add" onPress={submit} />
          </Row>
          {WHERE_TO_FIND[station] === undefined ? null : (
            <Text size="xs" role="secondary">
              {WHERE_TO_FIND[station]}
            </Text>
          )}
        </Col>
        <Suggestions senders={suggestionsOf(seen, entries)} busy={busy} onAdd={onAdd} />
        <Lookup agentId={agentId} station={station} accountId={accountId} busy={busy} onFound={onAdd} onError={onError} />
        {error === null ? null : (
          <Text size="xs" role="danger">
            {error}
          </Text>
        )}
      </Col>
    </Modal>
  );
}
