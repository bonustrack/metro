import { type ReactNode, useState } from 'react';
import { Col } from '@stage-labs/kit/react-native/box';
import { Text } from './ui.js';
import { Choice } from './Choice.js';
import { Loading } from './Loading.js';
import { ResourceChart } from './ResourceChart.js';
import { SettingsGroup } from './SettingsSection.js';
import { queryError, useResourcesQuery } from '../api/queries.js';
import { bytesOfLabel, percentLabel, RANGE_MS, RESOURCE_RANGES, type Resources, type ResourceRange } from '../api/resources.js';

const WARN = 0.9;

function Note({ text, danger = false }: { text: string; danger?: boolean }): ReactNode {
  return (
    <Text size="sm" role={danger ? 'danger' : 'secondary'}>
      {text}
    </Text>
  );
}

function Charts({ data, range }: { data: Resources; range: ResourceRange }): ReactNode {
  const last = data.samples.at(-1);
  if (last === undefined) return <Note text="No readings yet. Metro takes one every minute." />;
  const to = Date.now();
  const common = { range, from: to - RANGE_MS[range], to, stepMs: data.stepMs };
  const series = (pick: (s: Resources['samples'][number]) => number): { at: number; value: number }[] => data.samples.map((s) => ({ at: s.at, value: pick(s) }));
  return (
    <Col gap={24}>
      <ResourceChart {...common} title="CPU" points={series((s) => s.cpu)} max={100} label={percentLabel} />
      <ResourceChart
        {...common}
        title="Memory"
        points={series((s) => s.memUsed)}
        max={last.memTotal}
        label={(v) => bytesOfLabel(v, last.memTotal)}
        danger={last.memUsed >= WARN * last.memTotal}
      />
      <ResourceChart
        {...common}
        title="Disk"
        points={series((s) => s.diskUsed)}
        max={last.diskTotal}
        label={(v) => bytesOfLabel(v, last.diskTotal)}
        danger={last.diskUsed >= WARN * last.diskTotal}
      />
    </Col>
  );
}

function Body({ range }: { range: ResourceRange }): ReactNode {
  const query = useResourcesQuery(range);
  if (query.error !== null) return <Note text={queryError(query.error, 'Could not read the usage of this server.')} danger />;
  if (query.data === undefined) return <Loading />;
  if (query.data === null) return <Note text="Update Metro on this server to see its CPU, memory and disk charts." />;
  return <Charts data={query.data} range={range} />;
}

export function ServerResources(): ReactNode {
  const [range, setRange] = useState<ResourceRange>('1h');
  return (
    <SettingsGroup title="Usage" action={<Choice label="Time range" value={range} options={RESOURCE_RANGES} onChange={setRange} />}>
      <div className="settings-pad">
        <Body range={range} />
      </div>
    </SettingsGroup>
  );
}
