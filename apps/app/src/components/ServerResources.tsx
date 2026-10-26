import { type ReactNode, useState } from 'react';
import { Column } from '@stage-labs/kit/react-native/column';
import { Text } from '@stage-labs/kit/react-native/text';
import { Choice } from './Choice.js';
import { ErrorState } from './ui/ErrorState.js';
import { RowsSkeleton } from './ui/RowsSkeleton.js';
import { ResourceChart } from './ResourceChart.js';
import { Group } from './ui/Group.js';
import { Block } from './settings/rows.js';
import { queryError, useUsageQuery } from '../lib/queries.js';
import { creditsLabel, healthOf, percentLabel, RESOURCE_RANGES, type ResourceRange, type Series, type UsageCharts } from '@metro-labs/client/api/resources';

const WARN = 90;

function Note({ text, danger = false }: { text: string; danger?: boolean }): ReactNode {
  return (
    <Text size="xs" color={danger ? 'danger' : 'secondary'}>
      {text}
    </Text>
  );
}

const nearlyFull = (series: Series): boolean => (series.points.at(-1)?.value ?? 0) >= WARN;

function Charts({ usage, range }: { usage: UsageCharts; range: ResourceRange }): ReactNode {
  const health = healthOf(usage, range);
  const common = { range, from: usage.from, to: usage.to, restarts: usage.restarts };
  const chart = (title: string, series: Series, max: number, label: (value: number) => string, danger = false): ReactNode => (
    <ResourceChart {...common} title={title} points={series.points} stepMs={series.stepMs} max={max} label={label} danger={danger} />
  );
  const credits = usage.credits.points;
  return (
    <Column gap={24}>
      <Note text={health.text} danger={health.danger} />
      {chart('CPU', usage.cpu, 100, percentLabel)}
      {credits.length === 0 ? null : chart('CPU credits', usage.credits, Math.max(1, ...credits.map((p) => p.value)), creditsLabel)}
      {chart('Memory', usage.memory, 100, percentLabel, nearlyFull(usage.memory))}
      {chart('Disk', usage.disk, 100, percentLabel, nearlyFull(usage.disk))}
      {usage.restarts.length === 0 ? null : <Note text="Dashed lines are restarts: red for the server, grey for Metro. Point at one for the time." />}
      {usage.note === null ? null : <Note text={usage.note} />}
    </Column>
  );
}

export function ServerResources({ serverId }: { serverId: string }): ReactNode {
  const [range, setRange] = useState<ResourceRange>('1h');
  const query = useUsageQuery(serverId, range);
  const data = query.data;
  if (data === null) return null;
  const body =
    data === undefined ? (
      query.error === null ? <RowsSkeleton rows={2} leading={false} /> : <ErrorState title="Could not read the usage of this server" text={queryError(query.error, 'Metro did not answer.')} onRetry={query.refetch} />
    ) : data.available ? (
      <Charts usage={data} range={range} />
    ) : (
      <Note text={data.reason} />
    );
  const choice = data?.available === false ? undefined : <Choice label="Time range" value={range} options={RESOURCE_RANGES} onChange={setRange} />;
  return (
    <Group label="Usage" action={choice}>
      <Block>{body}</Block>
    </Group>
  );
}
