import { useEffect, useState, type ReactNode } from 'react';
import { StyleSheet, useWindowDimensions } from 'react-native';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { Button } from '@stage-labs/kit/react-native/button';
import { Modal } from '@stage-labs/kit/react-native/modal';
import { Text } from '@stage-labs/kit/react-native/text';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import type { AgentSummary } from '@metro-labs/client/api/client';
import type { ClaudeSessionStatus } from '@metro-labs/client/api/claude-box';
import type { ModelSettings } from '@metro-labs/client/api/model';
import { RUN_EVENTS_SINCE, RunEventsUnavailableError } from '@metro-labs/client/api/run-events';
import { olderThan } from '@metro-labs/client/api/version';
import { daemonBase } from '@metro-labs/client/auth/daemon';
import { queryError, useClaudeSessionQuery, useModeQuery, useModelQuery, useStationsQuery } from '../lib/queries.js';
import { useDocumentTitle } from '../lib/title.js';
import { runAccessDenied } from '../lib/run-cache.js';
import { PageTitle } from './PageTitle.js';
import { RunCoverage } from './run/Coverage.js';
import { RunCurrent } from './run/Current.js';
import { RunSessionDetails, selectedModel } from './run/SessionDetails.js';
import { RunTimeline } from './run/Timeline.js';
import { metroEntry, type RetainedRunFeed } from './run/metro-entries.js';
import { stamp, type RunEntry } from './run/model.js';
import { freshness, sdkEntries, sessionIdentity } from './run/session.js';
import { useRunFeed } from './run/use-run-feed.js';

const styles = StyleSheet.create({ grow: { flex: 1, minWidth: 0 } });

function useNow(): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => { setNow(Date.now()); }, 1_000);
    return () => { clearInterval(timer); };
  }, []);
  return now;
}

function FeedNotice({ unsupported, pending, error, updatedAt, catchingUp }: {
  unsupported: boolean; pending: boolean; error: Error | null; updatedAt: number; catchingUp: boolean;
}): ReactNode {
  if (unsupported) return <Text size="sm" role="secondary">Update this box to Metro {RUN_EVENTS_SINCE} or later for its message feed. SDK activity can still appear below.</Text>;
  if (error !== null) return <Text size="sm" role="danger">Metro feed disconnected. {queryError(error, 'Could not read recent events.')}{updatedAt > 0 && !runAccessDenied(error) ? ` Last confirmed ${stamp(updatedAt)}.` : ''}</Text>;
  if (pending) return <Text size="2xs" role="secondary">Loading retained Metro events…</Text>;
  return <Text size="2xs" role="secondary">{catchingUp ? 'Catching up with retained events…' : `Metro feed checked ${stamp(updatedAt)}. Polled every 5 seconds.`}</Text>;
}

function combinedEntries(feed: RetainedRunFeed | undefined, status: ClaudeSessionStatus | undefined, agent: AgentSummary | undefined, now: number, disconnected: boolean): RunEntry[] {
  return [...(feed?.events ?? []).map((event) => metroEntry(event, agent?.name ?? event.agentId)), ...sdkEntries(status, now, disconnected)]
    .sort((a, b) => b.at - a.at || a.id.localeCompare(b.id));
}

function runScope(feed: RetainedRunFeed | undefined, status: ClaudeSessionStatus | undefined): string {
  const activity = status?.activity;
  return `${String(feed?.generation ?? 0)}:${activity === null || activity === undefined ? 'none' : sessionIdentity(activity)}`;
}

function snapshotLabel(status: ClaudeSessionStatus | undefined): string {
  const activity = status?.activity;
  return activity === null || activity === undefined ? 'No SDK snapshot yet' : `SDK snapshot ${stamp(activity.updatedAt)}`;
}

function visibleModel(model: ModelSettings | undefined, error: Error | null, refused: boolean): ModelSettings | undefined {
  return error !== null || refused ? undefined : model;
}

function useRunSources(agent: AgentSummary | undefined, agentError: Error | null, now: number) {
  const session = useClaudeSessionQuery({ live: true });
  const model = useModelQuery();
  const mode = useModeQuery();
  const version = mode.data?.version ?? null;
  const feed = useRunFeed(agent?.id ?? '', version, !mode.isPending && agent !== undefined);
  const unsupported = olderThan(version, RUN_EVENTS_SINCE) || feed.error instanceof RunEventsUnavailableError;
  const refused = [session.error, model.error, feed.error, agentError].some(runAccessDenied);
  const status = refused ? undefined : session.data;
  const feedData = refused || unsupported ? undefined : feed.data;
  return {
    session, feed, unsupported, status, feedData,
    state: freshness(status, now, session.isError), settings: visibleModel(model.data, model.error, refused),
    entries: combinedEntries(feedData, status, agent, now, session.isError), scope: runScope(feedData, status),
  };
}

function AgentNotice({ error, pending }: { error: Error | null; pending: boolean }): ReactNode {
  if (error !== null) return <Text size="sm" role="danger">{queryError(error, 'Could not read this agent.')} The Metro feed is unavailable until its agent identity can be read.</Text>;
  return <Text size="sm" role="secondary">{pending ? 'Loading agent details…' : 'Waiting for this box’s agent.'}</Text>;
}

function RunData({ agent, agentError, agentPending }: { agent: AgentSummary | undefined; agentError: Error | null; agentPending: boolean }): ReactNode {
  const dark = useKitScheme() === 'dark';
  const narrow = useWindowDimensions().width < 700;
  const now = useNow();
  const data = useRunSources(agent, agentError, now);
  const [coverage, setCoverage] = useState(false);
  const [details, setDetails] = useState(false);
  const [focus, setFocus] = useState({ worker: 'All', revision: 0, scope: '' });
  const initialWorker = focus.scope === data.scope ? focus.worker : 'All';
  return <Col gap={24} testID="run-page">
    <Col gap={10}>
      <Row gap={8} align="center" wrap><PageTitle>Run</PageTitle><Col style={styles.grow} />
        <Button dark={dark} color="secondary" variant="ghost" label="What is available?" onPress={() => { setCoverage(true); }} /></Row>
      <Row gap={8} align="center" wrap><Text size="sm" weight="semibold">{agent?.name ?? 'Agent'}</Text>
        <Text size="sm" role="secondary">Selected model: {selectedModel(data.settings)}</Text></Row>
      {agent === undefined && <AgentNotice error={agentError} pending={agentPending} />}
      <Text size="2xs" role="secondary">{snapshotLabel(data.status)} · {data.state}</Text>
    </Col>
    <RunCurrent status={data.status} now={now} disconnected={data.session.isError} narrow={narrow} onSession={() => { setDetails(true); }}
      onWorker={(worker) => { setFocus((current) => ({ worker, revision: current.revision + 1, scope: data.scope })); }} />
    <RunTimeline key={`${data.scope}:${String(focus.revision)}`} initialWorker={initialWorker} entries={data.entries} now={now}
      notice={<FeedNotice unsupported={data.unsupported} pending={data.feed.isPending} error={data.feed.error} updatedAt={data.feed.dataUpdatedAt} catchingUp={data.feedData?.hasMore === true} />} />
    <Modal open={coverage} onClose={() => { setCoverage(false); }} title="Available data" side={narrow ? 'bottom' : 'center'}><RunCoverage /></Modal>
    <Modal open={details} onClose={() => { setDetails(false); }} title="Session details" side={narrow ? 'bottom' : 'center'}><RunSessionDetails status={data.status} model={data.settings} state={data.state} /></Modal>
  </Col>;
}

export function RunPage(): ReactNode {
  const stations = useStationsQuery();
  useDocumentTitle('Run');
  const agent = runAccessDenied(stations.error) ? undefined : stations.data?.agent;
  return <RunData key={`${daemonBase()}:${agent?.id ?? 'loading'}`} agent={agent} agentError={stations.error} agentPending={stations.isPending} />;
}
