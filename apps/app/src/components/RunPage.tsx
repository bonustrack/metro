import { useState, type ReactNode } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { Text } from '@stage-labs/kit/react-native/text';
import type { AgentSummary } from '@metro-labs/client/api/client';
import type { ClaudeSessionStatus } from '@metro-labs/client/api/claude-box';
import type { ModelSettings } from '@metro-labs/client/api/model';
import { RUN_EVENTS_SINCE, RunEventsUnavailableError } from '@metro-labs/client/api/run-events';
import { olderThan } from '@metro-labs/client/api/version';
import { daemonBase } from '@metro-labs/client/auth/daemon';
import { routeHash } from '@metro-labs/client/route';
import type { RunView } from '@metro-labs/client/selection';
import { queryError, useClaudeSessionQuery, useModeQuery, useStationsQuery } from '../lib/queries.js';
import { useModelQuery } from '../lib/model-queries.js';
import { useIsNarrow } from '../lib/media.js';
import { go } from '../lib/nav.js';
import { webOnly } from '../lib/style.js';
import { useDocumentTitle } from '../lib/title.js';
import { useNow } from '../lib/use-now.js';
import { runAccessDenied } from '../lib/run-cache.js';
import { AgentDeepPage } from './agent/AgentDeepPage.js';
import { Readable, Wide } from './ui/Layout.js';
import { RoundButton } from './ui/RoundButton.js';
import { FACTS_WIDTH, WIDE_WIDTH } from './ui/sizes.js';
import { useTechnicalDetails } from '../lib/technical.js';
import { rightNow, runSummary } from '../lib/right-now.js';
import { entryTime } from './run/words.js';
import { RunCurrent } from './run/Current.js';
import { DETAIL_TITLE, RunDetail } from './run/Details.js';
import { selectedModel } from './run/SessionDetails.js';
import { RunTimeline, useTimeline } from './run/Timeline.js';
import { metroEntry, type RetainedRunFeed } from './run/metro-entries.js';
import { runKey, stamp, type RunEntry } from './run/model.js';
import { freshness, sdkEntries, sessionIdentity } from './run/session.js';
import { useRunFeed } from './run/use-run-feed.js';

const RAIL_GAP = 56;
const STICKY = webOnly({ position: 'sticky', top: 24 });

function FeedNotice({ unsupported, pending, error, updatedAt, catchingUp }: {
  unsupported: boolean; pending: boolean; error: Error | null; updatedAt: number; catchingUp: boolean;
}): ReactNode {
  const technical = useTechnicalDetails();
  const checked = technical ? stamp(updatedAt) : entryTime(updatedAt, false);
  if (unsupported) return <Text size="xs" role="secondary">Update Metro to {RUN_EVENTS_SINCE} or later to see messages here.</Text>;
  if (error !== null) return <Text size="xs" role="danger">Messages are not updating. {queryError(error, 'Could not read recent events.')}{updatedAt > 0 && !runAccessDenied(error) ? ` Last updated ${checked}.` : ''}</Text>;
  if (pending) return <Text size="xs" role="secondary">Loading…</Text>;
  return <Text size="xs" role="secondary">{catchingUp ? 'Catching up…' : technical ? `Metro feed checked ${checked}. Polled every 5 seconds.` : `Updated ${checked}.`}</Text>;
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

type RunSources = ReturnType<typeof useRunSources>;

function AgentNotice({ error, pending }: { error: Error | null; pending: boolean }): ReactNode {
  if (error !== null) return <Text size="xs" role="danger">{queryError(error, 'Could not read this agent.')} Messages show once the agent loads.</Text>;
  return <Text size="xs" role="secondary">{pending ? 'Loading…' : 'Waiting for the agent.'}</Text>;
}

interface AgentState {
  agent: AgentSummary | undefined;
  agentError: Error | null;
  agentPending: boolean;
}

function RunFacts({ agent, data, agentError, agentPending }: AgentState & { data: RunSources }): ReactNode {
  const technical = useTechnicalDetails();
  if (!technical && agent !== undefined) return null;
  return <Col gap={10}>
    {technical && <Text size="xs" role="secondary">{agent?.name ?? 'Agent'} · Selected model: {selectedModel(data.settings)} · {snapshotLabel(data.status)} · {data.state}</Text>}
    {agent === undefined && <AgentNotice error={agentError} pending={agentPending} />}
  </Col>;
}

function DetailRail({ project, view, children }: { project: string; view: RunView | undefined; children: ReactNode }): ReactNode {
  const shown = view ?? 'session';
  return (
    <Col gap={16}>
      <Row align="center" justify="between" gap={12} minHeight={40}>
        <Text size="md" weight="semibold">{DETAIL_TITLE[shown]}</Text>
        {shown === 'session' ? null : <RoundButton label="Close details" icon="close" ghost onPress={() => { go({ kind: 'run', project }); }} />}
      </Row>
      {children}
    </Col>
  );
}

interface BodyProps extends AgentState {
  project: string;
  view: RunView | undefined;
  id: string | undefined;
  data: RunSources;
  now: number;
  initialWorker: string;
  onActivity: (worker: string) => void;
}

function RunBody({ project, view, id, data, now, initialWorker, onActivity, ...agent }: BodyProps): ReactNode {
  const narrow = useIsNarrow();
  const timeline = useTimeline(data.entries, now, initialWorker);
  const open = (next: RunView, target?: string): void => {
    go(target === undefined ? { kind: 'run', project, view: next } : { kind: 'run', project, view: next, id: runKey(target) });
  };
  const detail = <RunDetail view={view ?? 'session'} id={id} entries={data.entries} filtered={timeline.filtered} status={data.status} settings={data.settings} state={data.state}
    now={now} disconnected={data.session.isError} onEvent={(target) => { open('event', target); }} onActivity={onActivity} />;
  if (narrow && view !== undefined)
    return (
      <AgentDeepPage project={project} tab="home" trail={[{ label: 'Right now', href: routeHash({ kind: 'run', project }) }, { label: DETAIL_TITLE[view] }]} title={DETAIL_TITLE[view]}>
        <Readable>{detail}</Readable>
      </AgentDeepPage>
    );
  const main = (
    <>
      <RunFacts {...agent} data={data} />
      <RunCurrent status={data.status} now={now} disconnected={data.session.isError} onSession={() => { open('session'); }} onHelper={(helper) => { open('worker', helper); }} />
      <RunTimeline data={timeline} entries={data.entries} onSelect={(target) => { open('event', target); }}
        notice={<FeedNotice unsupported={data.unsupported} pending={data.feed.isPending} error={data.feed.error} updatedAt={data.feed.dataUpdatedAt} catchingUp={data.feedData?.hasMore === true} />} />
    </>
  );
  const explain = <Text size="xs" onPress={() => { open('about'); }} accessibilityRole="button">What is shown here?</Text>;
  return (
    <AgentDeepPage project={project} tab="home" trail={[{ label: 'Right now' }]} title="Right now" subtitle={data.status === undefined ? undefined : runSummary(rightNow(data.status, now))} action={explain}>
      {narrow ? (
        <Wide gap={40}>{main}</Wide>
      ) : (
        <Row align="start" gap={RAIL_GAP} width="100%" maxWidth={WIDE_WIDTH} testID="run-page">
          <Col flex={1} minWidth={0} gap={40}>{main}</Col>
          <Col width={FACTS_WIDTH} style={STICKY}>
            <DetailRail project={project} view={view}>{detail}</DetailRail>
          </Col>
        </Row>
      )}
    </AgentDeepPage>
  );
}

function RunData({ project, view, id, ...agent }: AgentState & { project: string; view: RunView | undefined; id: string | undefined }): ReactNode {
  const now = useNow();
  const data = useRunSources(agent.agent, agent.agentError, now);
  const [focus, setFocus] = useState({ worker: 'All', revision: 0, scope: '' });
  const initialWorker = focus.scope === data.scope ? focus.worker : 'All';
  const activity = (worker: string): void => {
    setFocus((current) => ({ worker, revision: current.revision + 1, scope: data.scope }));
    go({ kind: 'run', project });
  };
  return <RunBody key={`${data.scope}:${String(focus.revision)}`} project={project} view={view} id={id} data={data} now={now} initialWorker={initialWorker} onActivity={activity} {...agent} />;
}

export function RunPage({ project, view, id }: { project: string; view?: RunView; id?: string }): ReactNode {
  const stations = useStationsQuery();
  useDocumentTitle(view === undefined ? 'Right now' : DETAIL_TITLE[view]);
  const agent = runAccessDenied(stations.error) ? undefined : stations.data?.agent;
  return <RunData key={`${daemonBase()}:${agent?.id ?? 'loading'}`} project={project} view={view} id={id} agent={agent} agentError={stations.error} agentPending={stations.isPending} />;
}
