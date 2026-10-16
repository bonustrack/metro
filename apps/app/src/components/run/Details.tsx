import type { ReactNode } from 'react';
import { Col } from '@stage-labs/kit/react-native/box';
import { Button } from '@stage-labs/kit/react-native/button';
import { Text } from '@stage-labs/kit/react-native/text';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import type { ClaudeSessionStatus } from '@metro-labs/client/api/claude-box';
import type { ModelSettings } from '@metro-labs/client/api/model';
import type { RunView } from '@metro-labs/client/selection';
import { StateBlock } from '../ui/StateBlock.js';
import { RunCoverage } from './Coverage.js';
import { RunInspector } from './Inspector.js';
import { RunSessionDetails } from './SessionDetails.js';
import { runKey, type RunEntry } from './model.js';
import { sessionView, type Freshness } from './session.js';

export const DETAIL_TITLE: Record<RunView, string> = { session: 'Session details', about: 'What is shown here', helper: 'Helper details', event: 'Event details' };

export interface RunDetailProps {
  view: RunView;
  id: string | undefined;
  entries: RunEntry[];
  filtered: RunEntry[];
  status: ClaudeSessionStatus | undefined;
  settings: ModelSettings | undefined;
  state: Freshness;
  now: number;
  disconnected: boolean;
  onEvent: (id: string) => void;
  onActivity: (worker: string) => void;
}

function HelperDetail({ id, status, now, disconnected, onActivity }: Pick<RunDetailProps, 'id' | 'status' | 'now' | 'disconnected' | 'onActivity'>): ReactNode {
  const dark = useKitScheme() === 'dark';
  const workers = status === undefined ? [] : (sessionView(status, now, disconnected)?.workers ?? []);
  const worker = workers.find((row) => runKey(row.id) === id);
  if (worker === undefined) return <StateBlock icon="users" title="This helper is gone" text="Only the last 30 tasks of this session are kept." />;
  return (
    <Col gap={16} align="start">
      <Text size="sm" selectable>{worker.details}</Text>
      <Button dark={dark} color="secondary" label="Show its activity" onPress={() => { onActivity(worker.id); }} />
    </Col>
  );
}

function EventDetail({ id, entries, filtered, onEvent }: Pick<RunDetailProps, 'id' | 'entries' | 'filtered' | 'onEvent'>): ReactNode {
  const entry = entries.find((row) => runKey(row.id) === id);
  if (entry === undefined) return <StateBlock icon="clock" title="This event is gone" text="Only recent events are kept." />;
  return <RunInspector key={entry.id} entry={entry} entries={entries} onSelect={onEvent} visible={filtered.some((row) => row.id === entry.id)} />;
}

export function RunDetail(props: RunDetailProps): ReactNode {
  const { view } = props;
  if (view === 'about') return <RunCoverage />;
  if (view === 'helper') return <HelperDetail {...props} />;
  if (view === 'event') return <EventDetail {...props} />;
  return <RunSessionDetails status={props.status} model={props.settings} state={props.state} />;
}
