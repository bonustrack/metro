import { type ReactNode, useState } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitPalette, useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Button, Input, Text } from './ui.js';
import { GROW, SHRINK } from '../theme.js';
import { allowsEveryone, EVERYONE } from '../api/accounts.js';
import { fetchRecentSenders, setAllowlist, type RecentSender } from '../api/attach.js';
import { queryError } from '../api/queries.js';

const SAVE_FAILED = 'Could not save who may reach this agent.';
const NO_INPUT = { autoComplete: 'off', autoCapitalize: 'none', autoCorrect: false, spellCheck: false } as const;
const OPEN = 'Messages from anyone else still arrive on this station, and metro drops them before the agent sees them. Remove every sender and anyone can reach it again.';
const CLOSED = 'Every message on this station reaches the agent.';
const EMPTY = 'No sender is listed yet, so anyone can reach this agent. Add the first one below.';

interface EditorProps {
  entries: string[];
  seen: RecentSender[];
  busy: string | null;
  onAdd: (id: string) => void;
  onRemove: (id: string) => void;
}

function SenderRow({ id, name, busy, onRemove }: { id: string; name: string; busy: boolean; onRemove: () => void }): ReactNode {
  const palette = useKitPalette();
  const dark = useKitScheme() === 'dark';
  return (
    <Row justify="between" align="center" gap={12} padding={{ y: 10 }} border={{ bottom: { width: 1, color: palette.border } }}>
      <Col gap={2} style={SHRINK}>
        <Text size="sm" numberOfLines={1}>{name === '' ? id : name}</Text>
        {name === '' ? null : <Text size="sm" role="secondary" numberOfLines={1}>{id}</Text>}
      </Col>
      <Button size="sm" color="secondary" dark={dark} disabled={busy} label="Remove" onPress={onRemove} />
    </Row>
  );
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

function Editor({ entries, seen, busy, onAdd, onRemove }: EditorProps): ReactNode {
  const dark = useKitScheme() === 'dark';
  const [draft, setDraft] = useState('');
  const submit = (): void => {
    onAdd(draft);
    setDraft('');
  };
  const nameOf = (id: string): string => seen.find((s) => s.id === id)?.name ?? '';
  return (
    <Col gap={12}>
      {entries.length === 0 ? (
        <Text size="sm" role="secondary">{EMPTY}</Text>
      ) : (
        <Col>
          {entries.map((entry) => (
            <SenderRow
              key={entry}
              id={entry}
              name={nameOf(entry)}
              busy={busy !== null}
              onRemove={() => {
                onRemove(entry);
              }}
            />
          ))}
        </Col>
      )}
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
    </Col>
  );
}

interface AllowlistProps {
  agentId: string;
  station: string;
  accountId: string;
  allowlist: string[] | null;
  onSaved: () => Promise<unknown>;
}

export function Allowlist({ agentId, station, accountId, allowlist, onSaved }: AllowlistProps): ReactNode {
  const dark = useKitScheme() === 'dark';
  const everyone = allowsEveryone(allowlist);
  const entries = (allowlist ?? []).filter((entry) => entry !== EVERYONE);
  const [restricting, setRestricting] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [seen, setSeen] = useState<RecentSender[]>([]);
  const editing = !everyone || restricting;

  const save = (next: string[], what: string): void => {
    setBusy(what);
    setError(null);
    setAllowlist(agentId, station, accountId, next)
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
      {editing ? <Editor entries={entries} seen={seen} busy={busy} onAdd={add} onRemove={(id) => { save(entries.filter((e) => e !== id), id); }} /> : null}
      {error === null ? null : <Text size="sm" role="danger">{error}</Text>}
    </Col>
  );
}
