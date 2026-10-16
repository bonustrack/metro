import { type ReactNode, useState } from 'react';
import { Text } from '@stage-labs/kit/react-native/text';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { EVERYONE } from '@metro-labs/client/api/accounts';
import { setAllowlist } from '@metro-labs/client/api/attach';
import { Icon } from '../Icon.js';
import { Item } from '../ui/Item.js';
import { AddPerson } from './AddPerson.js';
import { PersonRow } from './PersonRow.js';
import { SAVE_FAILED } from './people-text.js';
import { Section } from './Section.js';
import { useSenderCards } from './use-sender-cards.js';
import {
  approverNames, approvesInChat, entriesOf, keptApprovers, peopleHeading, peopleOf, questionsGoTo, withApprover, withoutPerson, withPerson, writersOf, type Person,
} from '../../lib/channel-people.js';
import { useAgentName } from '../../lib/agent-hooks.js';
import { queryError } from '../../lib/queries.js';
import { useTechnicalDetails } from '../../lib/technical.js';

const MARK = 22;
const NOBODY = 'Nobody added yet, so anyone can still write. Add the first person below.';
const DUPLICATE = 'This person is already in the list.';

type Report = (message: string | null) => void;

interface ChannelPeopleProps {
  agentId: string;
  station: string;
  accountId: string;
  handle: string;
  allowlist: string[] | null;
  approvers: string[];
  onSaved: () => Promise<unknown>;
}

function Check({ on }: { on: boolean }): ReactNode {
  const palette = useKitPalette();
  return on ? <Icon name="check" size={MARK} color={palette.link} /> : null;
}

function anyoneNote(chat: boolean, name: string): string {
  return chat ? `Anyone who writes here reaches ${name}. Nobody can approve in this chat, so questions show on Home.` : `Anyone who writes here reaches ${name}.`;
}

function Questions({ people, handle }: { people: Person[]; handle: string }): ReactNode {
  const goes = questionsGoTo(approverNames(people), handle);
  return (
    <Section label="Approval questions go to">
      <Item title={goes.title} subtitle={goes.subtitle} chevron={false} />
    </Section>
  );
}

interface PeopleListProps {
  people: Person[];
  heading: string;
  chat: boolean;
  busy: boolean;
  error: string | null;
  onApprove: (id: string, approves: boolean) => void;
  onRemove: (id: string) => void;
  onAdd: () => void;
}

function PeopleList({ people, heading, chat, busy, error, onApprove, onRemove, onAdd }: PeopleListProps): ReactNode {
  const palette = useKitPalette();
  const name = useAgentName();
  return (
    <Section
      label={heading}
      right={chat ? <Text size="xs" role="secondary">Can approve</Text> : undefined}
      note={chat ? `People who can approve say yes or no when ${name} asks first.` : undefined}
      error={error}
    >
      {people.map((person) => (
        <PersonRow key={person.id} person={person} busy={busy} onApprove={(yes) => { onApprove(person.id, yes); }} onRemove={() => { onRemove(person.id); }} />
      ))}
      <Item title="Add a person" leading={<Icon name="plus" size={MARK} color={palette.link} />} chevron={false} onPress={onAdd} />
    </Section>
  );
}

function whoNote(editing: boolean, empty: boolean, chat: boolean, name: string): string | undefined {
  if (!editing) return anyoneNote(chat, name);
  return empty ? NOBODY : undefined;
}

export function ChannelPeople({ agentId, station, accountId, handle, allowlist, approvers, onSaved }: ChannelPeopleProps): ReactNode {
  const technical = useTechnicalDetails();
  const name = useAgentName();
  const entries = entriesOf(allowlist);
  const cards = useSenderCards(agentId, station, accountId, entries);
  const [restricting, setRestricting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const restricted = writersOf(allowlist) === 'some';
  const editing = restricted || restricting;
  const chat = approvesInChat(station);
  const people = peopleOf({ station, entries, approvers, cards, seen: [], technical });

  const save = (next: string[], nextApprovers: string[], report: Report, after?: () => void): void => {
    setBusy(true);
    report(null);
    setAllowlist(agentId, station, accountId, next, nextApprovers)
      .then(() => onSaved())
      .then(() => {
        setRestricting(false);
        after?.();
      })
      .catch((err: unknown) => {
        report(queryError(err, SAVE_FAILED));
      })
      .finally(() => {
        setBusy(false);
      });
  };

  const add = (id: string): void => {
    if (busy) return;
    const next = withPerson(entries, id);
    if (next === null) setAddError(id.trim() === '' ? null : DUPLICATE);
    else save(next, keptApprovers(next, approvers), setAddError, () => { setAdding(false); });
  };

  const anyone = (): void => {
    setRestricting(false);
    if (restricted && !busy) save([EVERYONE], keptApprovers([EVERYONE], approvers), setError);
  };

  const remove = (id: string): void => {
    const next = withoutPerson(entries, id);
    save(next, keptApprovers(next, approvers), setError);
  };

  return (
    <>
      <Section label="Who can write" note={whoNote(editing, entries.length === 0, chat, name)} error={editing ? null : error}>
        <Item title="Only these people" trailing={<Check on={editing} />} chevron={false} onPress={() => { setError(null); setRestricting(true); }} />
        <Item title="Anyone" trailing={<Check on={!editing} />} chevron={false} onPress={anyone} />
      </Section>
      {editing ? (
        <PeopleList
          people={people}
          heading={peopleHeading(entries)}
          chat={chat}
          busy={busy}
          error={error}
          onApprove={(id, yes) => { save(entries, withApprover(approvers, id, yes), setError); }}
          onRemove={remove}
          onAdd={() => { setAddError(null); setAdding(true); }}
        />
      ) : null}
      {chat && editing ? <Questions people={people} handle={handle} /> : null}
      {adding ? (
        <AddPerson agentId={agentId} station={station} accountId={accountId} entries={entries} busy={busy} error={addError} onAdd={add} onError={setAddError} onClose={() => { setAdding(false); }} />
      ) : null}
    </>
  );
}
