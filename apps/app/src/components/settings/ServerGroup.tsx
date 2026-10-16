import { type ReactNode } from 'react';
import { latestLine } from '@metro-labs/client/api/latest-usage';
import { serverLabel, type Server } from '@metro-labs/client/api/servers';
import { jobRunning, phaseText } from '@metro-labs/client/api/size';
import { growRunning, growText } from '@metro-labs/client/api/storage';
import { routeHash } from '@metro-labs/client/route';
import { Group } from '../ui/Group.js';
import { Item } from '../ui/Item.js';
import { PowerRows } from './Power.js';
import { VersionRow } from './VersionRow.js';
import { useClaudeSessionQuery, useLatestUsageQuery, useServerStatus, useSizeQuery, useStorageQuery } from '../../lib/queries.js';
import { healthValue, regionShort, sizeValue, storageValue } from '../../lib/settings-values.js';
import { useTechnicalDetails } from '../../lib/technical.js';

interface Rows {
  server: Server;
  href: string;
  technical: boolean;
}

function HealthRow({ server, href, technical }: Rows): ReactNode {
  const status = useServerStatus(server.host);
  const session = useClaudeSessionQuery();
  const usage = useLatestUsageQuery().data?.[server.id];
  const health = healthValue({ state: status.data?.state, running: session.data?.running, disk: usage?.disk ?? null });
  const detail = technical && usage !== undefined ? latestLine(usage) : undefined;
  return <Item title="Health" subtitle={detail} value={health.text} valueTone={health.tone} href={href} />;
}

function SizeRow({ server, href, technical }: Rows): ReactNode {
  const size = useSizeQuery(server.id).data;
  if (size?.resizable !== true) return null;
  const note = jobRunning(size.job) && size.job !== null ? phaseText(size.job) : technical ? size.type : undefined;
  return <Item title="Size" subtitle={note} value={sizeValue(size.current)} href={href} />;
}

function RegionRow({ server, technical }: Rows): ReactNode {
  const size = useSizeQuery(server.id).data;
  if (size?.resizable !== true || size.region === '') return null;
  return <Item title="Region" subtitle={technical ? size.region : undefined} value={regionShort(size.region)} />;
}

function StorageRow({ server, href, technical }: Rows): ReactNode {
  const storage = useStorageQuery(server.id).data;
  const disk = useLatestUsageQuery().data?.[server.id]?.disk ?? null;
  if (storage?.growable !== true) return null;
  const note = storage.job !== null && growRunning(storage.job) ? growText(storage.job) : technical ? storage.type : undefined;
  return <Item title="Storage" subtitle={note} value={storageValue(storage.sizeGib, disk)} href={href} />;
}

export function ServerGroup({ server, project }: { server: Server; project: string }): ReactNode {
  const technical = useTechnicalDetails();
  const rows: Rows = { server, href: routeHash({ kind: 'server', project }), technical };
  return (
    <Group label="Server">
      <HealthRow {...rows} />
      <SizeRow {...rows} />
      <StorageRow {...rows} />
      <RegionRow {...rows} />
      <VersionRow />
      <PowerRows name={serverLabel(server)} />
    </Group>
  );
}
