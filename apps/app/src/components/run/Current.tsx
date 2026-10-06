import { useState, type ReactNode } from 'react';
import { StyleSheet } from 'react-native';
import { Badge } from '@stage-labs/kit/react-native/badge';
import { Box, Col, Row } from '@stage-labs/kit/react-native/box';
import { Button } from '@stage-labs/kit/react-native/button';
import { Card } from '@stage-labs/kit/react-native/card';
import { Modal } from '../Modal.js';
import { Text } from '@stage-labs/kit/react-native/text';
import { useKitPalette, useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { statusColor } from '../../lib/theme.js';
import { Icon } from '../Icon.js';
import { WORKER_STATE } from './worker-state.js';
import type { ClaudeSessionStatus } from '@metro-labs/client/api/claude-box';
import { freshness, sessionView, type Activity, type Freshness } from './session.js';

const styles = StyleSheet.create({ worker: { flex: 1, minWidth: 220 }, title: { flex: 1, minWidth: 0 } });

interface Props {
  status: ClaudeSessionStatus | undefined;
  now: number;
  disconnected: boolean;
  narrow: boolean;
  onSession: () => void;
  onWorker: (id: string) => void;
}

function unavailableNote(status: ClaudeSessionStatus | undefined, disconnected: boolean): string {
  if (disconnected) return 'Could not refresh the session. Anything below is the last observed state, not live.';
  if (status === undefined) return 'Loading session status…';
  if (!status.running) return status.blocked === null ? 'The session is not running. This page will not start it.' : 'Starting the session is blocked. Check Harness settings.';
  if (status.runner !== 'sdk') return 'This runner does not report live SDK activity. Metro messages remain available below.';
  return 'The session process is running, but no SDK activity has been reported. This is not a readiness check.';
}

type SessionView = ReturnType<typeof sessionView>;
type Worker = NonNullable<SessionView>['workers'][number];

interface MainSessionProps extends Pick<Props, 'status' | 'disconnected'> {
  view: SessionView;
  state: Freshness;
  observed: boolean;
  dark: boolean;
}

function CurrentHeader({ state, dark, onSession }: { state: Freshness; dark: boolean; onSession: Props['onSession'] }): ReactNode {
  const title = state === 'Fresh' ? 'Right now' : state === 'Stale' || state === 'Disconnected' ? 'Last observed state' : 'Session status';
  return <Row justify="between" align="center" wrap gap={8}>
    <Row gap={8} align="center"><Text weight="semibold">{title}</Text><Badge label={state} color={state === 'Stale' || state === 'Disconnected' ? 'warning' : undefined} /></Row>
    <Button dark={dark} color="secondary" label="Session details" onPress={onSession} />
  </Row>;
}

function MainPhaseBadge({ activity, state }: { activity: Activity | null | undefined; state: Freshness }): ReactNode {
  if (!activity) return null;
  return <Badge label={activity.mainPhase === 'approval' ? 'Waiting for approval' : `${activity.mainPhase}${state === 'Fresh' ? '' : ' at last report'}`} color={state === 'Fresh' && activity.mainPhase === 'error' ? 'danger' : undefined} />;
}

function MainSessionReport({ status, disconnected, view, state, observed }: Omit<MainSessionProps, 'dark'>): ReactNode {
  const activity = status?.activity;
  return <>
    {activity && observed && <Text size="sm" role="secondary">{state === 'Fresh' ? '' : 'At last report: '}{activity.pending} queued · {activity.workers} active workers · {activity.approvals} approvals</Text>}
    <Text size="2xs" role="secondary">{disconnected || view === null ? unavailableNote(status, disconnected) : view.note}</Text>
    {view?.failures.map((failure) => <Text key={failure.text} size="sm" role={failure.danger ? 'danger' : 'secondary'}>{failure.text}</Text>)}
  </>;
}

function MainSessionCard({ status, disconnected, view, state, observed, dark }: MainSessionProps): ReactNode {
  const activity = status?.activity;
  return <Card dark={dark}><Col gap={12}>
    <Row gap={8} align="center" wrap><Text size="sm" weight="semibold">Main session</Text>
      <MainPhaseBadge activity={activity} state={state} />
    </Row>
    <Text size="sm">{view?.main ?? unavailableNote(status, disconnected)}</Text>
    {view !== null && <Text size="sm" role="secondary">{view.tools}</Text>}
    <MainSessionReport status={status} disconnected={disconnected} view={view} state={state} observed={observed} />
    {activity?.approvals !== undefined && activity.approvals > 0 && <Text size="2xs" role="secondary">Approval decisions happen in the existing approval channel. This view cannot approve or cancel work.</Text>}
  </Col></Card>;
}

function WorkerCard({ row, dark, onDetails, onWorker }: { row: Worker; dark: boolean; onDetails: (id: string) => void; onWorker: Props['onWorker'] }): ReactNode {
  const palette = useKitPalette();
  const mark = WORKER_STATE[row.status];
  const color = mark.color === null ? palette.text : statusColor(mark.color, dark ? 'dark' : 'light');
  return <Col style={styles.worker}><Card dark={dark}><Col gap={8}>
    <Text size="sm" weight="semibold" numberOfLines={1}>{row.title}</Text>
    <Text size="2xs" role="secondary" numberOfLines={1}>Last observed model: {row.lastObservedModel}</Text>
    <Row gap={8} align="start"><Box accessibilityElementsHidden importantForAccessibility="no-hide-descendants" aria-hidden><Icon name={mark.icon} size={18} color={color} /></Box><Text size="sm" style={styles.title}>{row.summary}</Text></Row>
    <Row gap={8} wrap><Button dark={dark} color="secondary" label="Details" accessibilityLabel={`Details for worker ${row.id}`} onPress={() => { onDetails(row.id); }} />
      <Button dark={dark} color="secondary" label="Activity" accessibilityLabel={`Filter activity for worker ${row.id}`} onPress={() => { onWorker(row.id); }} /></Row>
  </Col></Card></Col>;
}

function CurrentWorkers({ workers, observed, dark, narrow, onWorker }: Pick<Props, 'narrow' | 'onWorker'> & { workers: Worker[]; observed: boolean; dark: boolean }): ReactNode {
  const [expanded, setExpanded] = useState(false);
  const [workerId, setWorkerId] = useState<string | null>(null);
  const worker = workers.find((row) => row.id === workerId);
  const shown = expanded ? workers : narrow ? [] : workers.slice(0, 3);
  return <>
    {workers.length > 0 && <Col gap={10}>
      <Row justify="between" align="center" wrap gap={8}><Text size="sm" weight="semibold">{observed ? 'Workers' : 'Last reported workers'}</Text>
        <Button dark={dark} color="secondary" label={expanded ? 'Show fewer workers' : `Show all workers (${String(workers.length)})`} onPress={() => { setExpanded(!expanded); }} accessibilityState={{ expanded }} /></Row>
      <Row gap={12} wrap align="start">{shown.map((row) => <WorkerCard key={row.id} row={row} dark={dark} onDetails={setWorkerId} onWorker={onWorker} />)}</Row>
      <Text size="2xs" role="secondary">Members of this SDK session, not a nested tree. Up to 30 recent tasks, including completed and background work.</Text>
    </Col>}
    <Modal open={worker !== undefined} onClose={() => { setWorkerId(null); }} title="Worker details" side={narrow ? 'bottom' : 'center'}>
      {worker !== undefined && <Text size="sm" selectable>{worker.details}</Text>}
    </Modal>
  </>;
}

export function RunCurrent({ status, now, disconnected, narrow, onSession, onWorker }: Props): ReactNode {
  const dark = useKitScheme() === 'dark';
  const state = freshness(status, now, disconnected);
  const view = status === undefined ? null : sessionView(status, now, disconnected);
  const observed = state === 'Fresh' || state === 'Stale' || state === 'Disconnected';
  return <Col gap={12} testID="current-status">
    <CurrentHeader state={state} dark={dark} onSession={onSession} />
    <MainSessionCard status={status} disconnected={disconnected} view={view} state={state} observed={observed} dark={dark} />
    <CurrentWorkers workers={view?.workers ?? []} observed={observed} dark={dark} narrow={narrow} onWorker={onWorker} />
  </Col>;
}
