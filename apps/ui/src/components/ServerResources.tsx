import { type ReactNode, useState } from 'react';
import { Col } from '@stage-labs/kit/react-native/box';
import { Text } from '@stage-labs/kit/react-native/text';
import { Choice } from './Choice.js';
import { Loading } from './Loading.js';
import { ResourceChart } from './ResourceChart.js';
import { SettingsGroup } from './SettingsSection.js';
import { queryError, useUsageQuery } from '../api/queries.js';
import { creditsLabel, healthOf, percentLabel, RESOURCE_RANGES, type ResourceRange, type Series, type UsageCharts } from '../api/resources.js';

const WARN = 90;

function Note({ text, danger = false }: { text: string; danger?: boolean }): ReactNode {
  return (
    <Text size="2xs" role={danger ? 'danger' : 'secondary'}>
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
    <Col gap={24}>
      <Note text={health.text} danger={health.danger} />
      {chart('CPU', usage.cpu, 100, percentLabel)}
      {credits.length === 0 ? null : chart('CPU credits', usage.credits, Math.max(1, ...credits.map((p) => p.value)), creditsLabel)}
      {chart('Memory', usage.memory, 100, percentLabel, nearlyFull(usage.memory))}
      {chart('Disk', usage.disk, 100, percentLabel, nearlyFull(usage.disk))}
      {usage.restarts.length === 0 ? null : <Note text="Dashed lines are restarts: red for the server, grey for Metro. Point at one for the time." />}
      {usage.note === null ? null : <Note text={usage.note} />}
    </Col>
  );
}

export function ServerResources({ serverId }: { serverId: string }): ReactNode {
  const [range, setRange] = useState<ResourceRange>('1h');
  const query = useUsageQuery(serverId, range);
  const data = query.data;
  if (data === null) return null;
  const body =
    data === undefined ? (
      query.error === null ? <Loading /> : <Note text={queryError(query.error, 'Could not read the usage of this server.')} danger />
    ) : data.available ? (
      <Charts usage={data} range={range} />
    ) : (
      <Note text={data.reason} />
    );
  const choice = data?.available === false ? undefined : <Choice label="Time range" value={range} options={RESOURCE_RANGES} onChange={setRange} />;
  return (
    <SettingsGroup title="Usage" action={choice}>
      <div className="settings-pad">{body}</div>
    </SettingsGroup>
  );
}
