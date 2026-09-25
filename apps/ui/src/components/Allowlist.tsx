import { type ReactNode, useState } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Button, Input, Text } from './ui.js';
import { GROW } from '../theme.js';
import { allowsEveryone, EVERYONE } from '../api/accounts.js';
import { fetchRecentSenders, lookupSender, setAllowlist, type RecentSender } from '../api/attach.js';
import { queryError, useBoxQuery } from '../api/queries.js';
import { fetchSenderCards, type SenderCard } from '../api/senders.js';
import { SenderRow } from './SenderRow.js';

const SAVE_FAILED = 'Could not save who may reach this agent.';
const NO_INPUT = { autoComplete: 'off', autoCapitalize: 'none', autoCorrect: false, spellCheck: false } as const;
const OPEN = 'Only these senders reach the agent, in groups too. Remove them all and anyone can again.';
const CLOSED = 'Every message on this station reaches the agent.';
const EMPTY = 'Nobody listed, so anyone can reach this agent.';
const NO_CHAT_APPROVALS = new Set(['outlook']);
const APPROVE_HINT = 'A sender marked Can approve may answer an approval request in this chat with "yes <id>". With nobody marked, requests wait on the agent page.';

const WHERE_TO_FIND: Record<string, string> = {
  'telegram-bot': 'A number. Have them write to the bot once and pick them below, or ask them to message @userinfobot.',
  telegram: 'A number. Have them write once and pick them below, or ask them to message @userinfobot.',
  'discord-bot': 'A long number. Turn Developer Mode on in Discord, then right-click the person and choose Copy User ID.',
  whatsapp: 'Their number followed by @s.whatsapp.net, or an id ending in @lid. Look the number up below and metro asks WhatsApp which one they are.',
  threema: 'Their 8-character Threema ID, as in ECHOECHO. The surest way is to have them write once and pick them below.',
  outlook: 'An email address, or @domain for everyone at a company, as in @anderra.ch. A subdomain needs its own entry.',
  xmtp: 'Their inbox id, the long hex string, not their wallet address. Have them write once and pick them below.',
};

const LINE_HINT = 'The last part of a metro:// line is what goes here, and the whole line works too.';

const LOOKUP_PLACEHOLDER: Record<string, string> = {
  whatsapp: 'phone number, as in +41 79 123 45 67',
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
        Or find someone by their phone number, even one who has never written here.
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
      <Text size="sm" role="secondary">Seen on this station since the daemon started</Text>
      <Row gap={8} wrap>
        {senders.map((sender) => (
          <Button
            key={sender.id}
            size="sm"
            color="secondary"
            dark={dark}
            disabled={busy}
            label={sender.name === '' ? sender.id : `${sender.name} · ${sender.id}`}
            onPress={() => {
              onAdd(sender.id);
            }}
          />
        ))}
      </Row>
    </Col>
  );
}

function Editor({ agentId, station, accountId, entries, seen, busy, onAdd, onRemove, onError, approvers, onApprove, cards }: EditorProps): ReactNode {
  const dark = useKitScheme() === 'dark';
  const [draft, setDraft] = useState('');
  const submit = (): void => {
    onAdd(draft);
    setDraft('');
  };
  const cardOf = (id: string): SenderCard | undefined => cards.find((c) => c.id.toLowerCase() === id.toLowerCase());
  const nameOf = (id: string): string => cardOf(id)?.name ?? seen.find((s) => s.id === id)?.name ?? '';
  return (
    <Col gap={12}>
      {entries.length === 0 ? (
        <Text size="sm" role="secondary">{EMPTY}</Text>
      ) : (
        <Col>
          {entries.map((entry) => (
            <SenderRow
              key={entry}
              station={station}
              id={entry}
              name={nameOf(entry)}
              handle={cardOf(entry)?.handle ?? ''}
              busy={busy !== null}
              approves={approvers === null ? null : isIn(approvers, entry)}
              onApprove={(approves) => {
                onApprove(entry, approves);
              }}
              onRemove={() => {
                onRemove(entry);
              }}
            />
          ))}
        </Col>
      )}
      {approvers === null || entries.length === 0 ? null : <Text size="sm" role="secondary">{APPROVE_HINT}</Text>}
      <Row gap={8} align="center" wrap>
        <Input
          name="sender"
          value={draft}
          placeholder="sender id, the last part of a metro:// line"
          disabled={busy !== null}
          dark={dark}
          inputProps={NO_INPUT}
          onChangeText={setDraft}
          onSubmit={submit}
          style={GROW}
        />
        <Button size="sm" dark={dark} disabled={busy !== null || draft.trim() === ''} label="Add" onPress={submit} />
      </Row>
      <Suggestions
        senders={seen.filter((s) => !entries.some((e) => e.toLowerCase() === s.id.toLowerCase()))}
        busy={busy !== null}
        onAdd={onAdd}
      />
      <Lookup
        agentId={agentId}
        station={station}
        accountId={accountId}
        busy={busy !== null}
        onFound={onAdd}
        onError={onError}
      />
    </Col>
  );
}

interface AllowlistProps {
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

const isIn = (list: string[], id: string): boolean => list.some((entry) => entry.toLowerCase() === id.toLowerCase());

export function Allowlist({ agentId, station, accountId, allowlist, approvers, onSaved }: AllowlistProps): ReactNode {
  const dark = useKitScheme() === 'dark';
  const shownApprovers = NO_CHAT_APPROVALS.has(station) ? null : approvers;
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

  return (
    <Col gap={12}>
      <Text size="lg" weight="semibold">Who this agent listens to</Text>
      <Row gap={8} wrap>
        <Button
          size="sm"
          color={editing ? 'secondary' : 'primary'}
          dark={dark}
          disabled={busy !== null}
          label="Anyone"
          onPress={() => {
            setRestricting(false);
            if (!everyone) save([EVERYONE], 'everyone');
          }}
        />
        <Button size="sm" color={editing ? 'primary' : 'secondary'} dark={dark} disabled={busy !== null} label="Only these senders" onPress={openEditor} />
      </Row>
      <Text size="sm" role="secondary">{editing ? OPEN : CLOSED}</Text>
      {editing ? <Text size="sm" role="secondary">{`${WHERE_TO_FIND[station] ?? ''} ${LINE_HINT}`.trim()}</Text> : null}
      {editing ? (
        <Editor
          agentId={agentId}
          station={station}
          accountId={accountId}
          entries={entries}
          seen={seen}
          busy={busy}
          onAdd={add}
          onRemove={(id) => { save(entries.filter((e) => e !== id), id); }}
          onError={setError}
          approvers={shownApprovers}
          cards={cards}
          onApprove={(id, yes) => {
            save(entries, id, yes ? [...approvers, id] : approvers.filter((a) => a.toLowerCase() !== id.toLowerCase()));
          }}
        />
      ) : null}
      {error === null ? null : <Text size="sm" role="danger">{error}</Text>}
    </Col>
  );
}
