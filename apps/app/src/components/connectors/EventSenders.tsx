import { type ReactNode, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { EVERYONE } from '@metro-labs/client/api/accounts';
import { setConnectorAgentEvents, type OrgConnector } from '@metro-labs/client/api/org-connectors';
import { NameModal } from '../NameModal.js';
import { DUPLICATE, NOBODY } from '../chats/people-text.js';
import { WhoCanWrite } from '../chats/WhoCanWrite.js';
import { Group } from '../ui/Group.js';
import { Item } from '../ui/Item.js';
import { entriesOf, withPerson, withoutPerson } from '../../lib/channel-people.js';
import { senderPeople, sendersShown, unnamedNote, type EventRow } from '../../lib/connector-events.js';
import { refreshOrgConnectors } from '../../lib/org-connector-queries.js';
import { queryError } from '../../lib/queries.js';

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

function whoNote(anyone: boolean, restricting: boolean, empty: boolean, name: string): string {
  if (anyone) return restricting ? NOBODY : `Events from anyone reach ${name}.`;
  return empty ? 'Nobody can write yet. Add a person, or choose Anyone.' : `Events from anyone else are dropped before they reach ${name}.`;
}

export function EventSenders({ connector, agentId, name, admin, rows, senders }: SendersProps): ReactNode {
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [restricting, setRestricting] = useState(false);
  const [adding, setAdding] = useState(false);
  if (!sendersShown(rows, senders)) return null;
  const anyone = senders.includes(EVERYONE);
  const entries = entriesOf(senders);
  const people = senderPeople(senders);
  const note = whoNote(anyone, restricting, entries.length === 0, name);
  if (!admin)
    return (
      <Group label="Who can write" note={people.length === 0 ? note : unnamedNote(rows, senders)}>
        {people.length === 0 ? <Item title={anyone ? 'Anyone' : 'Nobody'} /> : people.map((person) => <Item key={person.id} title={person.title} subtitle={person.subtitle ?? undefined} />)}
      </Group>
    );
  const save = async (next: string[]): Promise<void> => {
    setBusy(true);
    try {
      await setConnectorAgentEvents(connector.id, agentId, { senders: next });
      await refreshOrgConnectors(client);
      setRestricting(false);
    } finally {
      setBusy(false);
    }
  };
  const quietly = (next: string[]): void => {
    if (busy) return;
    setError(null);
    save(next).catch((err: unknown) => { setError(queryError(err, SAVE_FAILED)); });
  };
  const add = async (raw: string): Promise<void> => {
    const next = withPerson(entries, raw);
    if (next === null) throw new Error(DUPLICATE);
    await save(next);
  };
  return (
    <>
      <WhoCanWrite
        editing={!anyone || restricting}
        note={note}
        error={error}
        people={people}
        busy={busy}
        peopleNote={unnamedNote(rows, senders)}
        onRestrict={() => { setError(null); setRestricting(true); }}
        onAnyone={() => { setRestricting(false); if (!anyone) quietly([EVERYONE]); }}
        onRemove={(id) => { quietly(withoutPerson(entries, id)); }}
        onAdd={() => { setError(null); setAdding(true); }}
      />
      {adding ? <NameModal title="Add a person" action="Add" field="Their id" placeholder="Email address, or @company.com" text={HOW} failure={SAVE_FAILED} open onClose={() => { setAdding(false); }} onSubmit={add} /> : null}
    </>
  );
}
