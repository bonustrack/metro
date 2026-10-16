import { type ReactNode } from 'react';
import { Col } from '@stage-labs/kit/react-native/box';
import { Text } from '@stage-labs/kit/react-native/text';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { type Server } from '@metro-labs/client/api/servers';
import { latestParts } from '@metro-labs/client/api/latest-usage';
import { routeHash } from '@metro-labs/client/route';
import { AgentAvatar } from '../AgentAvatar.js';
import { ErrorState } from '../ui/ErrorState.js';
import { RoundButton } from '../ui/RoundButton.js';
import { RowsSkeleton } from '../ui/RowsSkeleton.js';
import { AVATAR_SIZE } from '../ui/sizes.js';
import { Spinner } from '../Spinner.js';
import { AvatarDot } from '../ui/AvatarDot.js';
import { CountPill } from '../ui/CountPill.js';
import { Rows } from '../ui/Group.js';
import { Item } from '../ui/Item.js';
import { ListPaneRow } from '../ui/ListPaneRow.js';
import { ListPane } from '../shell/ListPane.js';
import { TabRoot } from '../shell/TabRoot.js';
import { NoAgents } from './AgentsIdle.js';
import { shortVersion, technicalLine } from '../../lib/agent-line.js';
import { useAgentRows, type AgentRow } from '../../lib/agent-rows.js';
import { queryError, useLatestUsageQuery, useServersQuery } from '../../lib/queries.js';
import { useTechnicalDetails } from '../../lib/technical.js';
import { useListKeys } from '../../lib/list-keys.js';
import { openJump } from '../../lib/jump-store.js';
import { useDocumentTitle } from '../../lib/title.js';
import { go } from '../../lib/nav.js';

function useDetail(row: AgentRow): string | undefined {
  const technical = useTechnicalDetails();
  const usage = useLatestUsageQuery().data?.[row.server.id];
  if (!technical) return undefined;
  const version = row.status?.version;
  return technicalLine([row.server.host, version === null || version === undefined ? null : shortVersion(version), ...latestParts(usage)]);
}

function AgentRowView({ row, pane, selected }: { row: AgentRow; pane: boolean; selected: boolean }): ReactNode {
  const palette = useKitPalette();
  const detail = useDetail(row);
  const { server, line } = row;
  const href = routeHash({ kind: 'home', project: server.id });
  const trailing = row.waiting > 0 ? <CountPill count={row.waiting} /> : line.busy ? <Spinner color={palette.link} /> : undefined;
  if (pane)
    return (
      <ListPaneRow title={row.name} line={line.text} lineTone={line.tone} detail={detail} dot={line.dot} trailing={trailing} selected={selected} href={href}
        avatar={<AgentAvatar seed={server.host} src={server.avatar} size={AVATAR_SIZE.list} />} />
    );
  return (
    <Item title={row.name} subtitle={line.text} subtitleTone={line.tone} detail={detail} href={href} trailing={trailing} chevron={false}
      leading={<AvatarDot dot={line.dot}><AgentAvatar seed={server.host} src={server.avatar} size={AVATAR_SIZE.list} /></AvatarDot>} />
  );
}

function AgentRows({ servers, pane, selected }: { servers: Server[]; pane: boolean; selected: string | null }): ReactNode {
  const rows = useAgentRows(servers);
  const start = rows.findIndex((row) => row.server.id === selected || row.server.slug === selected);
  const order = rows.map((row) => row.server.id).join(' ');
  const cursor = useListKeys(rows.length, start, (at) => {
    const row = rows[at];
    if (row !== undefined) go({ kind: 'home', project: row.server.id });
  }, pane, order);
  const views = rows.map((row, at) => <AgentRowView key={row.server.id} row={row} pane={pane} selected={cursor === null ? at === start : at === cursor} />);
  return pane ? <Col>{views}</Col> : <Rows>{views}</Rows>;
}

function Body({ pane, selected }: { pane: boolean; selected: string | null }): ReactNode {
  const { data, error, isPending, refetch } = useServersQuery();
  if (isPending) return <RowsSkeleton rows={4} pane={pane} trailing={false} />;
  if (error !== null)
    return (
      <Col padding={pane ? { x: 12, top: 12 } : undefined}>
        <ErrorState title="Could not list your agents" text={queryError(error, 'Metro did not answer.')} onRetry={refetch} />
      </Col>
    );
  if (data.length === 0)
    return pane ? (
      <Col padding={{ x: 12, top: 12 }}>
        <Text size="xs" role="secondary">No agents yet.</Text>
      </Col>
    ) : (
      <NoAgents />
    );
  return <AgentRows servers={data} pane={pane} selected={selected} />;
}

function SearchAgents(): ReactNode {
  return <RoundButton label="Jump" icon="search" onPress={openJump} />;
}

function NewAgent(): ReactNode {
  return <RoundButton label="New agent" icon="plus" onPress={() => { go({ kind: 'launch' }); }} />;
}

export function AgentList({ pane, selected = null }: { pane: boolean; selected?: string | null }): ReactNode {
  if (pane)
    return (
      <ListPane title="Agents" action={<NewAgent />}>
        <Body pane selected={selected} />
      </ListPane>
    );
  return <AgentsRoot />;
}

function AgentsRoot(): ReactNode {
  useDocumentTitle('Agents');
  return (
    <TabRoot title="Agents" action={<><SearchAgents /><NewAgent /></>}>
      <Body pane={false} selected={null} />
    </TabRoot>
  );
}
