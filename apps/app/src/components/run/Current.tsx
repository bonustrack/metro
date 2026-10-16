import { useState, type ReactNode } from 'react';
import { View } from 'react-native';
import { Badge } from '@stage-labs/kit/react-native/badge';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { Text } from '@stage-labs/kit/react-native/text';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import type { ClaudeSessionStatus } from '@metro-labs/client/api/claude-box';
import { LEGACY_RUNNER_NOTE } from '@metro-labs/client/api/runner';
import { Icon } from '../Icon.js';
import { Dropdown } from '../Dropdown.js';
import { Item } from '../ui/Item.js';
import { StatusDot } from '../home/SectionParts.js';
import { Group } from '../ui/Group.js';
import { WORKER_FILTERS, WORKER_STATE, workerSelection, type WorkerFilter } from './worker-state.js';
import { freshness, sessionView, type Activity, type Freshness } from './session.js';
import { FRESHNESS_WORD, TASK_WORD } from './words.js';
import type { NowDot } from '../../lib/right-now.js';
import { useTechnicalDetails } from '../../lib/technical.js';

const STATE_ICON = 20;

interface Props {
  status: ClaudeSessionStatus | undefined;
  now: number;
  disconnected: boolean;
  onSession: () => void;
  onHelper: (id: string) => void;
}

function unavailableNote(status: ClaudeSessionStatus | undefined, disconnected: boolean): string {
  if (disconnected) return 'Could not reach the agent. This is the last known state.';
  if (status === undefined) return 'Loading…';
  if (!status.running) return status.blocked === null ? 'The agent is not running. Start it in Settings, Agent SDK setup.' : 'The agent cannot start. See Settings, Agent SDK setup.';
  if (status.legacyRunner) return `${LEGACY_RUNNER_NOTE} Messages still show below.`;
  return 'The agent is running and has not reported any work yet.';
}

type SessionView = ReturnType<typeof sessionView>;
export type Worker = NonNullable<SessionView>['workers'][number];

const MAIN_DOT: Record<Activity['mainPhase'], NowDot> = {
  starting: 'quiet', idle: 'quiet', working: 'success', approval: 'white', compacting: 'success', stopped: 'quiet', error: 'danger',
};

function mainDot(activity: Activity | null | undefined, state: Freshness): NowDot {
  if (activity === null || activity === undefined) return 'quiet';
  return state === 'Fresh' ? MAIN_DOT[activity.mainPhase] : 'quiet';
}

function sectionTitle(state: Freshness): string {
  return state === 'Fresh' ? 'Main thread' : state === 'Stale' || state === 'Disconnected' ? 'Last known state' : 'The agent';
}

interface NotesInput {
  activity: Activity | null | undefined;
  view: SessionView;
  state: Freshness;
  observed: boolean;
  disconnected: boolean;
}

function countsNote({ activity, state, observed }: NotesInput): string | null {
  if (activity === null || activity === undefined || !observed) return null;
  return `${state === 'Fresh' ? '' : 'At last report: '}${String(activity.pending)} queued · ${String(activity.workers)} helpers · ${String(activity.approvals)} approvals`;
}

function notesOf(input: NotesInput, technical: boolean): (string | null)[] {
  const answer = (input.activity?.approvals ?? 0) > 0 ? 'Answer on Home or in the chat.' : null;
  if (!technical) return [answer];
  return [countsNote(input), input.view === null || input.disconnected ? null : input.view.note, answer];
}

function MainNotes(input: NotesInput): ReactNode {
  const technical = useTechnicalDetails();
  const { view } = input;
  const notes = notesOf(input, technical);
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

const MAIN_WORD: Record<Activity['mainPhase'], string> = {
  starting: 'Starting', idle: 'Waiting for messages', working: 'Working', approval: 'Waiting for you', compacting: 'Making room in its memory', stopped: 'Stopped', error: 'Ran into a problem',
};

const mainWord = (activity: Activity | null | undefined): string => (activity === null || activity === undefined ? 'Running' : MAIN_WORD[activity.mainPhase]);

function MainThread({ status, disconnected, view, state, observed, onSession }: Pick<Props, 'status' | 'disconnected' | 'onSession'> & { view: SessionView; state: Freshness; observed: boolean }): ReactNode {
  const technical = useTechnicalDetails();
  const activity = status?.activity;
  const action = (
    <Row gap={10} align="center">
      <Badge label={technical ? state : FRESHNESS_WORD[state]} color={state === 'Stale' || state === 'Disconnected' ? 'warning' : undefined} />
      <Text size="xs" onPress={onSession} accessibilityRole="button">Details</Text>
    </Row>
  );
  return (
    <Col gap={10}>
      <Group wide label={sectionTitle(state)} action={action}>
        <Item title={view === null ? unavailableNote(status, disconnected) : technical ? view.main : mainWord(activity)} subtitle={technical ? view?.tools : undefined} leading={<StatusDot tone={mainDot(activity, state)} />} />
      </Group>
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

function CurrentWorkers({ workers, observed, onHelper }: Pick<Props, 'onHelper'> & { workers: Worker[]; observed: boolean }): ReactNode {
  const technical = useTechnicalDetails();
  const [expanded, setExpanded] = useState(false);
  const [filter, setFilter] = useState<WorkerFilter>('all');
  const { matching, shown } = workerSelection(workers, filter, expanded);
  if (workers.length === 0 && filter === 'all') return null;
  return (
    <Col gap={10} testID="current-workers">
      <Group wide label={observed ? 'Helpers' : 'Last reported helpers'} action={<WorkerControls filter={filter} expanded={expanded} count={matching.length}
        onFilter={(value) => { setFilter(value); setExpanded(true); }} onExpand={() => { setExpanded(!expanded); }} />}>
        {shown.map((row) => (
          <Item key={row.id} title={row.title} subtitle={technical ? `${row.stateLabel} · ${row.tools}` : TASK_WORD[row.status]} subtitleTone={row.danger ? 'danger' : 'secondary'} detail={technical ? row.progress : undefined}
            leading={<StateMark row={row} />} onPress={() => { onHelper(row.id); }} label={`Details for helper ${row.id}`} />
        ))}
      </Group>
      <Text size="xs" role="secondary" accessibilityLiveRegion="polite">
        {matching.length === 0 ? 'No helpers with this status.' : `Showing ${String(shown.length)} of ${String(matching.length)}, finished ones included.`}
      </Text>
    </Col>
  );
}

export function RunCurrent({ status, now, disconnected, onSession, onHelper }: Props): ReactNode {
  const state = freshness(status, now, disconnected);
  const view = status === undefined ? null : sessionView(status, now, disconnected);
  const observed = state === 'Fresh' || state === 'Stale' || state === 'Disconnected';
  return (
    <Col gap={40} testID="current-status">
      <MainThread status={status} disconnected={disconnected} view={view} state={state} observed={observed} onSession={onSession} />
      <CurrentWorkers workers={view?.workers ?? []} observed={observed} onHelper={onHelper} />
    </Col>
  );
}
