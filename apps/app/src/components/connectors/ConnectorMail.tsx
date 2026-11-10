import { type ReactNode, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { CheckBox } from '@stage-labs/kit/react-native/check-box';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { isMailConnector, setOrgConnectorAgentMail, type AgentMailChange, type OrgConnector } from '@metro-labs/client/api/org-connectors';
import { Icon } from '../Icon.js';
import { NameModal } from '../NameModal.js';
import { PersonRow } from '../chats/PersonRow.js';
import { Group } from '../ui/Group.js';
import { Item } from '../ui/Item.js';
import { ICON_SIZE } from '../ui/sizes.js';
import { anyoneWrites, mailEntries, mailPeople, nextSenders, withMailEntry, withoutMailEntry } from '../../lib/connector-mail.js';
import { logError } from '../../lib/log.js';
import { refreshOrgConnectors } from '../../lib/org-connector-queries.js';
import { queryError } from '../../lib/queries.js';

const MARK = ICON_SIZE.md;
const SAVE_FAILED = 'Could not save. Try again.';
const RECEIVE_NOTE = 'Off stops new mail. The tools keep working.';
const NOBODY = 'Nobody added yet, so anyone can still write. Add the first person below.';
const DOMAIN_NOTE = '@company.com lets in everyone at that company. A subdomain needs its own entry.';
const ADMIN_ONLY = 'Only an admin of the organization can change this.';

interface MailProps {
  connector: OrgConnector;
  agentId: string;
  name: string;
  admin: boolean;
}

interface Saver {
  busy: boolean;
  attempt: (change: AgentMailChange) => Promise<string | null>;
}

function useMailSave(connectorId: string, agentId: string): Saver {
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const attempt = async (change: AgentMailChange): Promise<string | null> => {
    setBusy(true);
    try {
      await setOrgConnectorAgentMail(connectorId, agentId, change);
      await refreshOrgConnectors(client);
      return null;
    } catch (err) {
      return queryError(err, SAVE_FAILED);
    } finally {
      setBusy(false);
    }
  };
  return { busy, attempt };
}

function Check({ on }: { on: boolean }): ReactNode {
  const palette = useKitPalette();
  return on ? <Icon name="check" size={MARK} color={palette.link} /> : null;
}

function Receive({ receive, admin, saver }: { receive: boolean; admin: boolean; saver: Saver }): ReactNode {
  const [shown, setShown] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const toggle = (next: boolean): void => {
    setShown(next);
    setError(null);
    saver.attempt({ receive: next })
      .then((failure) => {
        setError(failure);
        setShown(null);
      })
      .catch(logError('connector-mail'));
  };
  return (
    <Group error={error} note={admin ? undefined : ADMIN_ONLY}>
      <Item title="Receive messages" subtitle={RECEIVE_NOTE} trailing={<CheckBox displayStyle="switch" value={shown ?? receive} disabled={!admin || saver.busy} name="Receive messages" onChange={toggle} />} />
    </Group>
  );
}

function ReadOnlyPeople({ senders, name }: { senders: string[]; name: string }): ReactNode {
  if (anyoneWrites(senders)) {
    return (
      <Group label="Who can write" note={ADMIN_ONLY}>
        <Item title="Anyone" subtitle={`Anyone who writes to this mailbox reaches ${name}.`} chevron={false} />
      </Group>
    );
  }
  return (
    <Group label="People" note={ADMIN_ONLY}>
      {mailPeople(mailEntries(senders)).map((person) => (
        <Item key={person.id} title={person.title} subtitle={person.subtitle ?? undefined} chevron={false} />
      ))}
    </Group>
  );
}

interface ListProps {
  entries: string[];
  saver: Saver;
  error: string | null;
  onRemove: (id: string) => void;
  onAdd: () => void;
}

function PeopleList({ entries, saver, error, onRemove, onAdd }: ListProps): ReactNode {
  const palette = useKitPalette();
  return (
    <Group label="People" note={DOMAIN_NOTE} error={error}>
      {mailPeople(entries).map((person) => (
        <PersonRow key={person.id} person={person} busy={saver.busy} onApprove={() => undefined} onRemove={() => { onRemove(person.id); }} />
      ))}
      <Item title="Add a person" leading={<Icon name="plus" size={MARK} color={palette.link} />} chevron={false} onPress={onAdd} />
    </Group>
  );
}

function EditPeople({ senders, name, saver }: { senders: string[]; name: string; saver: Saver }): ReactNode {
  const [restricting, setRestricting] = useState(false);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const entries = mailEntries(senders);
  const restricted = !anyoneWrites(senders);
  const editing = restricted || restricting;
  const store = (next: string[]): void => {
    setError(null);
    saver.attempt({ senders: nextSenders(next) })
      .then((failure) => {
        setError(failure);
        if (failure === null) setRestricting(false);
      })
      .catch(logError('connector-mail'));
  };
  const anyone = (): void => {
    setRestricting(false);
    if (restricted && !saver.busy) store([]);
  };
  const add = async (raw: string): Promise<void> => {
    const change = withMailEntry(entries, raw);
    if ('error' in change) throw new Error(change.error);
    const failure = await saver.attempt({ senders: nextSenders(change.next) });
    if (failure !== null) throw new Error(failure);
    setRestricting(false);
  };
  return (
    <>
      <Group label="Who can write" note={editing ? (entries.length === 0 ? NOBODY : undefined) : `Anyone who writes to this mailbox reaches ${name}.`} error={editing ? null : error}>
        <Item title="Only these people" trailing={<Check on={editing} />} chevron={false} onPress={() => { setError(null); setRestricting(true); }} />
        <Item title="Anyone" trailing={<Check on={!editing} />} chevron={false} onPress={anyone} />
      </Group>
      {editing ? <PeopleList entries={entries} saver={saver} error={error} onRemove={(id) => { store(withoutMailEntry(entries, id)); }} onAdd={() => { setAdding(true); }} /> : null}
      <NameModal key={adding ? 'open' : 'closed'} title="Add a person" action="Add" field="Email address" placeholder="Email address, or @company.com" failure={SAVE_FAILED} open={adding} onClose={() => { setAdding(false); }} onSubmit={add} />
    </>
  );
}

export function ConnectorMail({ connector, agentId, name, admin }: MailProps): ReactNode {
  const saver = useMailSave(connector.id, agentId);
  const held = connector.agents.find((agent) => agent.id === agentId);
  if (!isMailConnector(connector) || held === undefined) return null;
  return (
    <>
      <Receive receive={held.receive} admin={admin} saver={saver} />
      {admin ? <EditPeople senders={held.senders} name={name} saver={saver} /> : <ReadOnlyPeople senders={held.senders} name={name} />}
    </>
  );
}
