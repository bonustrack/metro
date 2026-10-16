import { useState, type ReactNode } from 'react';
import { View } from 'react-native';
import { Badge } from '@stage-labs/kit/react-native/badge';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { Button } from '@stage-labs/kit/react-native/button';
import { Text } from '@stage-labs/kit/react-native/text';
import { useKitPalette, useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import type { ClaudeSessionStatus } from '@metro-labs/client/api/claude-box';
import { LEGACY_RUNNER_NOTE } from '@metro-labs/client/api/runner';
import { Modal } from '../Modal.js';
import { Icon } from '../Icon.js';
import { Dropdown } from '../Dropdown.js';
import { Item } from '../ui/Item.js';
import { Section, StatusDot } from '../home/Section.js';
import { WORKER_FILTERS, WORKER_STATE, workerSelection, type WorkerFilter } from './worker-state.js';
import { freshness, sessionView, type Activity, type Freshness } from './session.js';
import type { NowDot } from '../../lib/right-now.js';

const STATE_ICON = 20;

interface Props {
  status: ClaudeSessionStatus | undefined;
  now: number;
  disconnected: boolean;
  narrow: boolean;
  onSession: () => void;
  onWorker: (id: string) => void;
}

function unavailableNote(status: ClaudeSessionStatus | undefined, disconnected: boolean): string {
  if (disconnected) return 'Could not refresh the session. Below is the last known state, not live.';
  if (status === undefined) return 'Loading session status…';
  if (!status.running) return status.blocked === null ? 'The session is not running. Start it in Harness settings.' : 'Starting the session is blocked. Check Harness settings.';
  if (status.legacyRunner) return `${LEGACY_RUNNER_NOTE} Messages still show below.`;
  return 'The session is running, but has reported no activity yet.';
}

type SessionView = ReturnType<typeof sessionView>;
type Worker = NonNullable<SessionView>['workers'][number];

const MAIN_DOT: Record<Activity['mainPhase'], NowDot> = {
  starting: 'quiet', idle: 'quiet', working: 'success', approval: 'white', compacting: 'success', stopped: 'quiet', error: 'danger',
};

function mainDot(activity: Activity | null | undefined, state: Freshness): NowDot {
  if (activity === null || activity === undefined) return 'quiet';
  return state === 'Fresh' ? MAIN_DOT[activity.mainPhase] : 'quiet';
}

function sectionTitle(state: Freshness): string {
  return state === 'Fresh' ? 'Main thread' : state === 'Stale' || state === 'Disconnected' ? 'Last observed state' : 'Session status';
}

function MainNotes({ activity, view, state, observed, disconnected }: { activity: Activity | null | undefined; view: SessionView; state: Freshness; observed: boolean; disconnected: boolean }): ReactNode {
  const counts = activity && observed ? `${state === 'Fresh' ? '' : 'At last report: '}${String(activity.pending)} queued · ${String(activity.workers)} helpers · ${String(activity.approvals)} approvals` : null;
  const notes = [counts, view === null || disconnected ? null : view.note, (activity?.approvals ?? 0) > 0 ? 'Answer approvals on Home or in the chat.' : null];
  return (
    <>
      {notes.map((note) => (note === null ? null : <Text key={note} size="xs" role="secondary">{note}</Text>))}
      {view?.failures.map((failure) => (
        <Text key={failure.text} size="xs" role={failure.danger ? 'danger' : 'secondary'}>
          {failure.text}
        </Text>
      ))}
    </>
  );
}

function MainThread({ status, disconnected, view, state, observed, onSession }: Pick<Props, 'status' | 'disconnected' | 'onSession'> & { view: SessionView; state: Freshness; observed: boolean }): ReactNode {
  const activity = status?.activity;
  const action = (
    <Row gap={10} align="center">
      <Badge label={state} color={state === 'Stale' || state === 'Disconnected' ? 'warning' : undefined} />
      <Text size="xs" onPress={onSession} accessibilityRole="button">Details</Text>
    </Row>
  );
  return (
    <Col gap={10}>
      <Section label={sectionTitle(state)} action={action}>
        <Item title={view?.main ?? unavailableNote(status, disconnected)} subtitle={view?.tools} leading={<StatusDot tone={mainDot(activity, state)} />} />
      </Section>
      <MainNotes activity={activity} view={view} state={state} observed={observed} disconnected={disconnected} />
    </Col>
  );
}

function StateMark({ row }: { row: Worker }): ReactNode {
  const palette = useKitPalette();
  const mark = WORKER_STATE[row.status];
  const color = mark.color === 'danger' ? palette.danger : mark.color === null ? palette.sub : palette.success;
  return (
    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <Icon name={mark.icon} size={STATE_ICON} color={color} />
    </View>
  );
}

interface WorkerControlsProps {
  filter: WorkerFilter;
  expanded: boolean;
  count: number;
  onFilter: (filter: WorkerFilter) => void;
  onExpand: () => void;
}

function WorkerControls({ filter, expanded, count, onFilter, onExpand }: WorkerControlsProps): ReactNode {
  const label = WORKER_FILTERS.find((option) => option.value === filter)?.label ?? 'All';
  return (
    <Row gap={12} align="center">
      <Dropdown label="Filter helper status" button={{ label: `${label} helpers`, color: 'secondary', size: 'sm' }} items={WORKER_FILTERS.map((option) => ({
        label: option.label, selected: option.value === filter, onSelect: () => { onFilter(option.value); },
      }))} />
      {count > 3 ? (
        <Text size="xs" onPress={onExpand} accessibilityRole="button" accessibilityState={{ expanded }}>
          {expanded ? 'Show fewer' : `Show all (${String(count)})`}
        </Text>
      ) : null}
    </Row>
  );
}

function WorkerDetails({ worker, narrow, onClose, onWorker }: { worker: Worker | undefined; narrow: boolean; onClose: () => void; onWorker: Props['onWorker'] }): ReactNode {
  const dark = useKitScheme() === 'dark';
  return (
    <Modal open={worker !== undefined} onClose={onClose} title="Helper details" side={narrow ? 'bottom' : 'center'}>
      {worker === undefined ? null : (
        <Col gap={16}>
          <Text size="sm" selectable>{worker.details}</Text>
          <Row>
            <Button dark={dark} color="secondary" label="Show its activity" onPress={() => { onWorker(worker.id); onClose(); }} />
          </Row>
        </Col>
      )}
    </Modal>
  );
}

function CurrentWorkers({ workers, observed, narrow, onWorker }: Pick<Props, 'narrow' | 'onWorker'> & { workers: Worker[]; observed: boolean }): ReactNode {
  const [expanded, setExpanded] = useState(false);
  const [filter, setFilter] = useState<WorkerFilter>('all');
  const [workerId, setWorkerId] = useState<string | null>(null);
  const worker = workers.find((row) => row.id === workerId);
  const { matching, shown } = workerSelection(workers, filter, expanded);
  if (workers.length === 0 && filter === 'all') return null;
  return (
    <Col gap={10} testID="current-workers">
      <Section label={observed ? 'Helpers' : 'Last reported helpers'} action={<WorkerControls filter={filter} expanded={expanded} count={matching.length}
        onFilter={(value) => { setFilter(value); setExpanded(true); }} onExpand={() => { setExpanded(!expanded); }} />}>
        {shown.map((row) => (
          <Item key={row.id} title={row.title} subtitle={`${row.stateLabel} · ${row.tools}`} subtitleTone={row.danger ? 'danger' : 'secondary'} detail={row.progress}
            leading={<StateMark row={row} />} onPress={() => { setWorkerId(row.id); }} label={`Details for helper ${row.id}`} />
        ))}
      </Section>
      <Text size="xs" role="secondary" accessibilityLiveRegion="polite">
        {matching.length === 0 ? 'No helpers with this status.' : `Showing ${String(shown.length)} of ${String(matching.length)}. Up to 30 recent tasks in this session, finished ones included.`}
      </Text>
      <WorkerDetails worker={worker} narrow={narrow} onClose={() => { setWorkerId(null); }} onWorker={onWorker} />
    </Col>
  );
}

export function RunCurrent({ status, now, disconnected, narrow, onSession, onWorker }: Props): ReactNode {
  const state = freshness(status, now, disconnected);
  const view = status === undefined ? null : sessionView(status, now, disconnected);
  const observed = state === 'Fresh' || state === 'Stale' || state === 'Disconnected';
  return (
    <Col gap={40} testID="current-status">
      <MainThread status={status} disconnected={disconnected} view={view} state={state} observed={observed} onSession={onSession} />
      <CurrentWorkers workers={view?.workers ?? []} observed={observed} narrow={narrow} onWorker={onWorker} />
    </Col>
  );
}
