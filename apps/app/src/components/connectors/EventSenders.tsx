import { type ReactNode, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { EVERYONE, allowsEveryone } from '@metro-labs/client/api/accounts';
import { setConnectorAgentEvents, type OrgConnector } from '@metro-labs/client/api/org-connectors';
import { Icon } from '../Icon.js';
import { NameModal } from '../NameModal.js';
import { Check, PersonRow } from '../chats/PersonRow.js';
import { Group } from '../ui/Group.js';
import { Item } from '../ui/Item.js';
import { ICON_SIZE } from '../ui/sizes.js';
import { entriesOf, withPerson, withoutPerson, type Person } from '../../lib/channel-people.js';
import { senderPeople, sendersShown, unnamedNote, type EventRow } from '../../lib/connector-events.js';
import { refreshOrgConnectors } from '../../lib/org-connector-queries.js';
import { queryError } from '../../lib/queries.js';

const NOBODY = 'Nobody added yet, so anyone can still write. Add the first person below.';
const DUPLICATE = 'This person is already in the list.';
const SAVE_FAILED = 'Could not save who can write.';
const HOW = 'Type their id as the connector names it, such as an email address, or @company.com for everyone at that company.';

interface SendersProps {
  connector: OrgConnector;
  agentId: string;
  name: string;
  admin: boolean;
  rows: readonly EventRow[];
  senders: string[];
}

interface Saving {
  busy: boolean;
  error: string | null;
  clear: () => void;
  save: (next: string[]) => Promise<void>;
  quietly: (next: string[]) => void;
}

function useSenders(connector: string, agentId: string): Saving {
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async (next: string[]): Promise<void> => {
    setBusy(true);
    try {
      await setConnectorAgentEvents(connector, agentId, { senders: next.length === 0 ? [EVERYONE] : next });
      await refreshOrgConnectors(client);
    } finally {
      setBusy(false);
    }
  };
  const quietly = (next: string[]): void => {
    if (busy) return;
    setError(null);
    save(next).catch((err: unknown) => { setError(queryError(err, SAVE_FAILED)); });
  };
  return { busy, error, clear: () => { setError(null); }, save, quietly };
}

function ReadOnly({ people, name, note }: { people: Person[]; name: string; note: string | undefined }): ReactNode {
  if (people.length === 0)
    return (
      <Group label="Who can write" note={`Events from anyone reach ${name}.`}>
        <Item title="Anyone" />
      </Group>
    );
  return (
    <Group label="Who can write" note={note}>
      {people.map((person) => <Item key={person.id} title={person.title} subtitle={person.subtitle ?? undefined} />)}
    </Group>
  );
}

function whoNote(editing: boolean, empty: boolean, name: string): string | undefined {
  if (!editing) return `Events from anyone reach ${name}.`;
  return empty ? NOBODY : `Events from anyone else are dropped before they reach ${name}.`;
}

export function EventSenders({ connector, agentId, name, admin, rows, senders }: SendersProps): ReactNode {
  const palette = useKitPalette();
  const saving = useSenders(connector.id, agentId);
  const [restricting, setRestricting] = useState(false);
  const [adding, setAdding] = useState(false);
  if (!sendersShown(rows, senders)) return null;
  const entries = entriesOf(senders);
  const people = senderPeople(senders);
  const note = unnamedNote(rows, senders);
  if (!admin) return <ReadOnly people={people} name={name} note={note} />;
  const editing = !allowsEveryone(senders) || restricting;
  const anyone = (): void => {
    setRestricting(false);
    if (entries.length > 0) saving.quietly([]);
  };
  const add = async (raw: string): Promise<void> => {
    const next = withPerson(entries, raw);
    if (next === null) throw new Error(DUPLICATE);
    await saving.save(next);
    setRestricting(false);
  };
  return (
    <>
      <Group label="Who can write" note={whoNote(editing, entries.length === 0, name)} error={editing ? null : saving.error}>
        <Item title="Only these people" trailing={<Check on={editing} />} chevron={false} onPress={() => { saving.clear(); setRestricting(true); }} />
        <Item title="Anyone" trailing={<Check on={!editing} />} chevron={false} onPress={anyone} />
      </Group>
      {editing ? (
        <Group label="People" note={note} error={saving.error}>
          {people.map((person) => (
            <PersonRow key={person.id} person={person} busy={saving.busy} onRemove={() => { saving.quietly(withoutPerson(entries, person.id)); }} />
          ))}
          <Item title="Add a person" leading={<Icon name="plus" size={ICON_SIZE.md} color={palette.link} />} chevron={false} onPress={() => { saving.clear(); setAdding(true); }} />
        </Group>
      ) : null}
      {adding ? (
        <NameModal title="Add a person" action="Add" field="Their id" placeholder="Email address, or @company.com" text={HOW} failure={SAVE_FAILED} open onClose={() => { setAdding(false); }} onSubmit={add} />
      ) : null}
    </>
  );
}
