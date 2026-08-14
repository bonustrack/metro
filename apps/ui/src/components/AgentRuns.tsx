import { type ReactNode, useEffect, useState } from 'react';
import { Box, Col, Row } from '@stage-labs/kit/react-native/box';
import { Card } from '@stage-labs/kit/react-native/card';
import { useKitPalette, useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Text } from './ui';
import { CARD_PADDING } from '../theme';
import { fetchRuns } from '../api/runs';
import { Loading } from './Loading';
import { RunChart } from './RunChart';
import {
  dayBuckets,
  durationMs,
  formatCount,
  formatDuration,
  formatTokens,
  summarize,
  totalTokens,
  type Run,
} from './runs';

const DAYS = 14;
const REFRESH_MS = 20_000;
const RECENT = 8;

type State =
  | { phase: 'loading' }
  | { phase: 'error'; message: string }
  | { phase: 'ready'; runs: Run[] };

function Panel({ title, children }: { title: string; children: ReactNode }): ReactNode {
  const dark = useKitScheme() === 'dark';
  return (
    <Card dark={dark} padding={CARD_PADDING}>
      <Col gap={14}>
        <Text size="lg" weight="semibold">
          {title}
        </Text>
        {children}
      </Col>
    </Card>
  );
}

function Tile({ label, value }: { label: string; value: string }): ReactNode {
  return (
    <Col gap={2} style={{ flexGrow: 1, flexShrink: 1, flexBasis: 120 }}>
      <Text size="2xl" weight="semibold">
        {value}
      </Text>
      <Text size="2xs" role="secondary">
        {label}
      </Text>
    </Col>
  );
}

function StateDot({ state }: { state: Run['state'] }): ReactNode {
  const palette = useKitPalette();
  const color =
    state === 'running'
      ? palette.success
      : state === 'lost'
        ? palette.danger
        : palette.sub;
  return <Box style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: color }} />;
}

function RunRow({ run, now }: { run: Run; now: number }): ReactNode {
  return (
    <Row justify="between" align="center" gap={10} wrap>
      <Row align="center" gap={8} style={{ flexShrink: 1, minWidth: 0 }}>
        <StateDot state={run.state} />
        <Col gap={1} style={{ flexShrink: 1, minWidth: 0 }}>
          <Text size="sm">{run.label ?? run.id}</Text>
          <Text size="2xs" role="secondary">
            {`${run.state} · ${run.type ?? 'agent'} · ${run.turns} turns`}
          </Text>
        </Col>
      </Row>
      <Text size="2xs" role="secondary">
        {`${formatDuration(durationMs(run, now))} · ${formatTokens(totalTokens(run))} tokens`}
      </Text>
    </Row>
  );
}

function RunLines({ runs, now, empty }: { runs: Run[]; now: number; empty: string }): ReactNode {
  if (runs.length === 0)
    return (
      <Text size="sm" role="secondary">
        {empty}
      </Text>
    );
  return (
    <Col gap={12}>
      {runs.map((run) => (
        <RunRow key={`${run.agentId}:${run.id}`} run={run} now={now} />
      ))}
    </Col>
  );
}

function Charts({ runs, now }: { runs: Run[]; now: number }): ReactNode {
  const buckets = dayBuckets(runs, DAYS, now);
  return (
    <Panel title={`The last ${DAYS} days`}>
      <RunChart
        title="Agents started"
        buckets={buckets}
        value={(b) => b.runs}
        format={formatCount}
      />
      <RunChart
        title="Tokens"
        buckets={buckets}
        value={(b) => b.tokens}
        format={formatTokens}
      />
      <RunChart
        title="Median run"
        buckets={buckets}
        value={(b) => b.medianMs}
        format={formatDuration}
      />
      <Text size="2xs" role="secondary">
        One bar is one UTC day. Tokens are input, output and cache reads and
        writes added together, so cache reads dominate the total.
      </Text>
    </Panel>
  );
}

function Tiles({ runs, now }: { runs: Run[]; now: number }): ReactNode {
  const stats = summarize(runs, now);
  return (
    <Row gap={16} wrap>
      <Tile label="running now" value={formatCount(stats.running)} />
      <Tile label={`agents, ${DAYS} days`} value={formatCount(stats.runs)} />
      <Tile label="tokens" value={formatTokens(stats.tokens)} />
      <Tile label="median run" value={formatDuration(stats.medianMs)} />
    </Row>
  );
}

function Feed({ runs, now }: { runs: Run[]; now: number }): ReactNode {
  const running = runs.filter((r) => r.state === 'running');
  const finished = runs.filter((r) => r.state !== 'running').slice(0, RECENT);
  return (
    <Col gap={20}>
      <Panel title="Running now">
        <RunLines runs={running} now={now} empty="No agent is running right now." />
      </Panel>
      <Charts runs={runs} now={now} />
      <Panel title="Finished most recently">
        <RunLines runs={finished} now={now} empty="Nothing has finished yet." />
        <Text size="2xs" role="secondary">
          A run is lost when no final answer was ever written: the agent was
          killed or interrupted before it reported back.
        </Text>
      </Panel>
    </Col>
  );
}

export function AgentRuns({ token }: { token: string }): ReactNode {
  const [state, setState] = useState<State>({ phase: 'loading' });
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let live = true;
    const load = (): void => {
      fetchRuns(token, DAYS)
        .then((feed) => {
          if (!live) return;
          setNow(Date.now());
          setState({ phase: 'ready', runs: feed.runs });
        })
        .catch((err: unknown) => {
          if (!live) return;
          setState({
            phase: 'error',
            message: err instanceof Error ? err.message : 'Failed to reach Metro.',
          });
        });
    };
    load();
    const timer = setInterval(load, REFRESH_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [token]);

  return (
    <Col gap={20}>
      <Col gap={2}>
        <Text size="2xl" weight="semibold">
          Subagent activity
        </Text>
        <Text size="2xs" role="secondary">
          What the agents behind this account are doing, pushed from the box they
          run on. It refreshes every {REFRESH_MS / 1000} seconds.
        </Text>
      </Col>
      {state.phase === 'loading' ? (
        <Loading />
      ) : state.phase === 'error' ? (
        <Panel title="Could not load activity">
          <Text size="sm" role="secondary">
            {state.message}
          </Text>
        </Panel>
      ) : (
        <Col gap={20}>
          <Tiles runs={state.runs} now={now} />
          <Feed runs={state.runs} now={now} />
        </Col>
      )}
    </Col>
  );
}
