import { type ReactNode, useState } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Button, Input, Text } from './ui.js';
import { GROW } from '../theme.js';
import { Choice } from './Choice.js';
import { SettingsGroup, SettingsSection } from './SettingsSection.js';
import { allowsEveryone, EVERYONE } from '../api/accounts.js';
import { fetchRecentSenders, lookupSender, setAllowlist, type RecentSender } from '../api/attach.js';
import { queryError, useBoxQuery } from '../api/queries.js';
import { fetchSenderCards, type SenderCard } from '../api/senders.js';
import { SenderRow } from './SenderRow.js';

const SAVE_FAILED = 'Could not save who may write to this agent.';
const NO_INPUT = { autoComplete: 'off', autoCapitalize: 'none', autoCorrect: false, spellCheck: false } as const;
const ONLY = 'Only the people below reach the agent, in groups too.';
const ANYONE = 'Anyone who writes here reaches the agent.';
const NOBODY = 'Nobody added yet, so anyone can still write. Add the first person below.';
const NO_CHAT_APPROVALS = new Set(['outlook']);
const APPROVE_NOTE = 'An approver can answer the agent’s approval requests right in this chat.';

const PLACEHOLDER: Record<string, string> = {
  'telegram-bot': 'Telegram user id, a number',
  telegram: 'Telegram user id, a number',
  'discord-bot': 'Discord user id, a long number',
  whatsapp: 'WhatsApp id',
  threema: 'Threema ID, like ECHOECHO',
  outlook: 'Email address, or @company.com',
  xmtp: 'Inbox id',
};

const WHERE_TO_FIND: Record<string, string> = {
  'telegram-bot': 'Easiest: have them write to the bot once, then pick them below.',
  telegram: 'Easiest: have them write once, then pick them below.',
  'discord-bot': 'In Discord, turn on Developer Mode, right-click the person and choose Copy User ID.',
  whatsapp: 'Easiest: look them up by phone number below.',
  threema: 'Easiest: have them write once, then pick them below.',
  outlook: '@company.com lets in everyone at that company. A subdomain needs its own entry.',
  xmtp: 'Their inbox id, not their wallet address. Easiest: have them write once, then pick them below.',
};

const LOOKUP_PLACEHOLDER: Record<string, string> = {
  whatsapp: 'Phone number, like +41 79 123 45 67',
};

const NOT_FOUND = 'WhatsApp does not know that number, so nobody could write from it.';
const LOOKUP_FAILED = 'Could not look that number up.';

interface LookupProps {
  agentId: string;
  station: string;
  accountId: string;
  busy: boolean;
  onFound: (id: string) => void;
  onError: (message: string | null) => void;
}

function Lookup({ agentId, station, accountId, busy, onFound, onError }: LookupProps): ReactNode {
  const dark = useKitScheme() === 'dark';
  const [draft, setDraft] = useState('');
  const [looking, setLooking] = useState(false);
  const placeholder = LOOKUP_PLACEHOLDER[station];
  if (placeholder === undefined) return null;
  const run = (): void => {
    const query = draft.trim();
    if (query === '' || looking || busy) return;
    setLooking(true);
    onError(null);
    lookupSender(agentId, station, accountId, query)
      .then((result) => {
        if (result.id === null) {
          onError(NOT_FOUND);
          return;
        }
        setDraft('');
        onFound(result.id);
      })
      .catch((err: unknown) => {
        onError(queryError(err, LOOKUP_FAILED));
      })
      .finally(() => {
        setLooking(false);
      });
  };
  return (
    <Col gap={8}>
      <Text size="sm" role="secondary">
        Find someone by phone number, even if they never wrote here.
      </Text>
      <Row gap={8} align="center" wrap>
        <Input
          name="sender-lookup"
          value={draft}
          placeholder={placeholder}
          disabled={busy || looking}
          dark={dark}
          inputProps={NO_INPUT}
          onChangeText={setDraft}
          onSubmit={run}
          style={GROW}
        />
        <Button
          size="sm"
          color="secondary"
          dark={dark}
          disabled={busy || looking || draft.trim() === ''}
          label={looking ? 'Looking…' : 'Look up'}
          onPress={run}
        />
      </Row>
    </Col>
  );
}

interface EditorProps {
  agentId: string;
  station: string;
  accountId: string;
  entries: string[];
  seen: RecentSender[];
  busy: string | null;
  onAdd: (id: string) => void;
  onRemove: (id: string) => void;
  onError: (message: string | null) => void;
  approvers: string[] | null;
  onApprove: (id: string, approves: boolean) => void;
  cards: SenderCard[];
}

function Suggestions({ senders, busy, onAdd }: { senders: RecentSender[]; busy: boolean; onAdd: (id: string) => void }): ReactNode {
  const dark = useKitScheme() === 'dark';
  if (senders.length === 0) return null;
  return (
    <Col gap={8}>
      <Text size="sm" role="secondary">Wrote recently</Text>
      <Row gap={8} wrap>
        {senders.map((sender) => (
          <Button
            key={sender.id}
            size="sm"
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

function AddPerson({ agentId, station, accountId, seen, entries, busy, onAdd, onError }: Omit<EditorProps, 'onRemove' | 'approvers' | 'onApprove' | 'cards'>): ReactNode {
  const dark = useKitScheme() === 'dark';
  const [draft, setDraft] = useState('');
  const submit = (): void => {
    onAdd(draft);
    setDraft('');
  };
  return (
    <div className="settings-pad">
      <Col gap={16}>
        <Col gap={8}>
          <Row gap={8} align="center" wrap>
            <Input
              name="sender"
              value={draft}
              placeholder={PLACEHOLDER[station] ?? 'Sender id'}
              disabled={busy !== null}
              dark={dark}
              inputProps={NO_INPUT}
              onChangeText={setDraft}
              onSubmit={submit}
              style={GROW}
            />
            <Button size="sm" color="secondary" dark={dark} disabled={busy !== null || draft.trim() === ''} label="Add" onPress={submit} />
          </Row>
          {WHERE_TO_FIND[station] === undefined ? null : <Text size="sm" role="secondary">{WHERE_TO_FIND[station]}</Text>}
        </Col>
        <Suggestions
          senders={seen.filter((s) => !entries.some((e) => e.toLowerCase() === s.id.toLowerCase()))}
          busy={busy !== null}
          onAdd={onAdd}
        />
        <Lookup agentId={agentId} station={station} accountId={accountId} busy={busy !== null} onFound={onAdd} onError={onError} />
      </Col>
    </div>
  );
}

function People({ station, entries, seen, busy, onRemove, approvers, onApprove, cards }: EditorProps): ReactNode {
  const cardOf = (id: string): SenderCard | undefined => cards.find((c) => c.id.toLowerCase() === id.toLowerCase());
  const nameOf = (id: string): string => cardOf(id)?.name ?? seen.find((s) => s.id === id)?.name ?? '';
  return entries.map((entry) => (
    <SenderRow
      key={entry}
      station={station}
      id={entry}
      name={nameOf(entry)}
      handle={cardOf(entry)?.handle ?? ''}
      avatar={cardOf(entry)?.avatar ?? null}
      busy={busy !== null}
      approves={approvers === null ? null : isIn(approvers, entry)}
      onApprove={(approves) => {
        onApprove(entry, approves);
      }}
      onRemove={() => {
        onRemove(entry);
      }}
    />
  ));
}

interface AllowlistProps {
  title: string;
  agentId: string;
  station: string;
  accountId: string;
  allowlist: string[] | null;
  approvers: string[];
  onSaved: () => Promise<unknown>;
}

function useSenderCards(agentId: string, station: string, accountId: string, entries: string[]): SenderCard[] {
  const cards = useBoxQuery(['sender-cards', agentId, station, accountId, entries.join('\n')], () => fetchSenderCards(agentId, station, accountId), {
    enabled: entries.length > 0,
    staleTime: 600_000,
  });
  return cards.data ?? [];
}

const chatApprovers = (station: string, approvers: string[]): string[] | null => (NO_CHAT_APPROVALS.has(station) ? null : approvers);

const isIn = (list: string[], id: string): boolean => list.some((entry) => entry.toLowerCase() === id.toLowerCase());

export function Allowlist({ title, agentId, station, accountId, allowlist, approvers, onSaved }: AllowlistProps): ReactNode {
  const shownApprovers = chatApprovers(station, approvers);
  const everyone = allowsEveryone(allowlist);
  const entries = (allowlist ?? []).filter((entry) => entry !== EVERYONE);
  const cards = useSenderCards(agentId, station, accountId, entries);
  const [restricting, setRestricting] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [seen, setSeen] = useState<RecentSender[]>([]);
  const editing = !everyone || restricting;

  const save = (next: string[], what: string, nextApprovers?: string[]): void => {
    setBusy(what);
    setError(null);
    setAllowlist(agentId, station, accountId, next, nextApprovers ?? approvers.filter((a) => isIn(next, a)))
      .then(() => onSaved())
      .then(() => {
        setRestricting(false);
      })
      .catch((err: unknown) => {
        setError(queryError(err, SAVE_FAILED));
      })
      .finally(() => {
        setBusy(null);
      });
  };

  const add = (id: string): void => {
    const value = id.trim();
    if (value === '' || busy !== null) return;
    if (entries.some((entry) => entry.toLowerCase() === value.toLowerCase())) return;
    save([...entries, value], value);
  };

  const openEditor = (): void => {
    setRestricting(true);
    setError(null);
    fetchRecentSenders(agentId, station, accountId)
      .then(setSeen)
      .catch(() => undefined);
  };

  const editorProps: EditorProps = {
    agentId,
    station,
    accountId,
    entries,
    seen,
    busy,
    onAdd: add,
    onRemove: (id) => {
      save(entries.filter((e) => e !== id), id);
    },
    onError: setError,
    approvers: shownApprovers,
    cards,
    onApprove: (id, yes) => {
      save(entries, id, yes ? [...approvers, id] : approvers.filter((a) => a.toLowerCase() !== id.toLowerCase()));
    },
  };
  const note = !editing ? ANYONE : entries.length === 0 ? NOBODY : ONLY;
  return (
    <SettingsGroup title={title} note={shownApprovers === null ? undefined : APPROVE_NOTE}>
      <SettingsSection title="People" note={note}>
        <Choice
          label="People"
          value={editing ? 'some' : 'anyone'}
          options={[
            { value: 'anyone', label: 'Anyone' },
            { value: 'some', label: 'Only people I choose' },
          ]}
          disabled={busy !== null}
          onChange={(value) => {
            if (value === 'some') {
              openEditor();
              return;
            }
            setRestricting(false);
            if (!everyone) save([EVERYONE], 'everyone');
          }}
        />
        {error === null ? null : <Text size="sm" role="danger">{error}</Text>}
      </SettingsSection>
      {editing ? <People {...editorProps} /> : null}
      {editing ? <AddPerson {...editorProps} /> : null}
    </SettingsGroup>
  );
}
