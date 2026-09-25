import { type ReactNode, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Text, Button } from './ui.js';
import { moveWorkspace, WORKSPACE_SINCE, type WorkspaceEntry } from '../api/agent-user.js';
import { queryError, refresh, useModeQuery, useWorkspaceQuery } from '../api/queries.js';
import { sizeLabel } from '../api/when.js';
import { olderThan } from '../api/version.js';

const ABOUT = 'Copy the agent\'s work from root\'s home to its own. The originals stay in /root. Hidden files, such as SSH keys and settings, are never offered.';

const STATE_TEXT: Record<WorkspaceEntry['state'], string> = { here: '', waiting: 'waiting', copying: 'copying…', moved: 'moved', failed: 'failed' };

const movable = (entry: WorkspaceEntry): boolean => entry.state === 'here' || entry.state === 'failed';

function detail(entry: WorkspaceEntry): string {
  const size = entry.bytes === null ? '' : sizeLabel(entry.bytes);
  return [entry.kind === 'folder' ? 'folder' : entry.kind, size, STATE_TEXT[entry.state]].filter((p) => p !== '').join(' · ');
}

function EntryRow({ entry, picked, onToggle }: { entry: WorkspaceEntry; picked: boolean; onToggle: () => void }): ReactNode {
  return (
    <Col gap={2}>
      <label className="move-row">
        <input type="checkbox" checked={picked} disabled={!movable(entry)} onChange={onToggle} />
        <Text size="sm">{entry.name}</Text>
        <Text size="sm" role="secondary">{detail(entry)}</Text>
      </label>
      {entry.error === null ? null : <Text size="sm" role="danger">{entry.error}</Text>}
    </Col>
  );
}

function List({ entries }: { entries: WorkspaceEntry[] }): ReactNode {
  const client = useQueryClient();
  const dark = useKitScheme() === 'dark';
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toggle = (name: string): void => {
    const next = new Set(picked);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    setPicked(next);
  };
  const move = (): void => {
    setBusy(true);
    setError(null);
    moveWorkspace([...picked])
      .then(() => {
        setPicked(new Set());
        return refresh(client, 'agent-workspace');
      })
      .catch((err: unknown) => {
        setError(queryError(err, 'Could not start the move.'));
      })
      .finally(() => {
        setBusy(false);
      });
  };
  const open = entries.filter(movable).map((e) => e.name);
  if (entries.length === 0) return <Text size="sm" role="secondary">Nothing to move: root's home holds only hidden files.</Text>;
  return (
    <Col gap={8}>
      <Row gap={10} align="center">
        <Button size="sm" color="secondary" dark={dark} label={`Select all (${String(open.length)})`} disabled={open.length === 0} onPress={() => { setPicked(new Set(open)); }} />
        <Button size="sm" color="secondary" dark={dark} label="Clear" disabled={picked.size === 0} onPress={() => { setPicked(new Set()); }} />
      </Row>
      <Col gap={4}>
        {entries.map((entry) => (
          <EntryRow
            key={entry.name}
            entry={entry}
            picked={picked.has(entry.name)}
            onToggle={() => {
              toggle(entry.name);
            }}
          />
        ))}
      </Col>
      <Row>
        <Button size="sm" color="secondary" dark={dark} label={`Move ${String(picked.size)}`} disabled={busy || picked.size === 0} onPress={move} />
      </Row>
      {error === null ? null : <Text size="sm" role="danger">{error}</Text>}
    </Col>
  );
}

export function MoveWork(): ReactNode {
  const mode = useModeQuery();
  const supported = mode.data !== undefined && !olderThan(mode.data.version, WORKSPACE_SINCE);
  const work = useWorkspaceQuery(supported);
  if (!supported) return null;
  return (
    <Col gap={8}>
      <Text size="sm" weight="semibold">Move work to the agent</Text>
      <Text size="sm" role="secondary">{ABOUT}</Text>
      {work.error !== null ? (
        <Text size="sm" role="danger">{queryError(work.error, 'Could not list root\'s home.')}</Text>
      ) : work.data === undefined ? (
        <Text size="sm" role="secondary">Reading root's home…</Text>
      ) : (
        <List entries={work.data} />
      )}
    </Col>
  );
}
