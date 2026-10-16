import { type ReactNode } from 'react';
import { Col } from '@stage-labs/kit/react-native/box';
import { Text } from '@stage-labs/kit/react-native/text';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { serverLabel, type Server } from '@metro-labs/client/api/servers';
import { latestLine } from '@metro-labs/client/api/latest-usage';
import { routeHash } from '@metro-labs/client/route';
import { AgentAvatar } from '../AgentAvatar.js';
import { Icon } from '../Icon.js';
import { Loading } from '../Loading.js';
import { RoundButton } from '../RoundButton.js';
import { Spinner } from '../Spinner.js';
import { AvatarDot } from '../ui/AvatarDot.js';
import { CountPill } from '../ui/CountPill.js';
import { Rows } from '../ui/Group.js';
import { Item } from '../ui/Item.js';
import { ListPaneRow } from '../ui/ListPaneRow.js';
import { ListPane } from '../shell/ListPane.js';
import { TabRoot } from '../shell/TabRoot.js';
import { NoAgents } from './AgentsIdle.js';
import { agentLine, technicalLine } from '../../lib/agent-line.js';
import { useWaitingOn } from '../../lib/agent-status.js';
import { queryError, useLatestUsageQuery, useServerStatus, useServersQuery } from '../../lib/queries.js';
import { useTechnicalDetails } from '../../lib/technical.js';
import { useBootingState } from '../../lib/use-launch.js';
import { useDocumentTitle } from '../../lib/title.js';
import { go } from '../../lib/nav.js';

const PANE_AVATAR = 36;
const PAGE_AVATAR = 44;
const PLUS = 20;

function AgentRow({ server, pane, selected }: { server: Server; pane: boolean; selected: boolean }): ReactNode {
  const palette = useKitPalette();
  const { data: status } = useServerStatus(server.host);
  const booting = useBootingState(server, status?.state === 'offline');
  const waiting = useWaitingOn(server, status);
  const technical = useTechnicalDetails();
  const usage = useLatestUsageQuery().data?.[server.id];
  const line = agentLine(status, booting, waiting);
  const detail = technical ? technicalLine([server.host, status?.version, usage === undefined ? null : latestLine(usage)]) : undefined;
  const trailing = waiting > 0 ? <CountPill count={waiting} /> : line.busy ? <Spinner color={palette.link} /> : undefined;
  const href = routeHash({ kind: 'home', project: server.id });
  const name = serverLabel(server);
  if (pane)
    return (
      <ListPaneRow title={name} line={line.text} lineTone={line.tone} detail={detail} dot={line.dot} trailing={trailing} selected={selected} href={href}
        avatar={<AgentAvatar seed={server.host} src={server.avatar} size={PANE_AVATAR} />} />
    );
  return (
    <Item title={name} subtitle={line.text} subtitleTone={line.tone} detail={detail} href={href} trailing={trailing} chevron={false}
      leading={<AvatarDot dot={line.dot}><AgentAvatar seed={server.host} src={server.avatar} size={PAGE_AVATAR} /></AvatarDot>} />
  );
}

function Body({ pane, selected }: { pane: boolean; selected: string | null }): ReactNode {
  const { data, error, isPending } = useServersQuery();
  if (isPending) return <Loading />;
  if (error !== null)
    return (
      <Text size="md" role="danger">
        {queryError(error, 'Could not list your agents.')}
      </Text>
    );
  if (data.length === 0)
    return pane ? (
      <Col padding={{ x: 12, top: 12 }}>
        <Text size="xs" role="secondary">No agents yet.</Text>
      </Col>
    ) : (
      <NoAgents />
    );
  const rows = data.map((server) => <AgentRow key={server.id} server={server} pane={pane} selected={server.id === selected || server.slug === selected} />);
  return pane ? <Col>{rows}</Col> : <Rows>{rows}</Rows>;
}

function NewAgent({ size }: { size: number }): ReactNode {
  const palette = useKitPalette();
  return (
    <RoundButton label="New agent" size={size} onPress={() => { go({ kind: 'launch' }); }}>
      <Icon name="plus" size={PLUS} color={palette.link} />
    </RoundButton>
  );
}

export function AgentList({ pane, selected = null }: { pane: boolean; selected?: string | null }): ReactNode {
  if (pane)
    return (
      <ListPane title="Agents" action={<NewAgent size={36} />}>
        <Body pane selected={selected} />
      </ListPane>
    );
  return <AgentsRoot />;
}

function AgentsRoot(): ReactNode {
  useDocumentTitle('Agents');
  return (
    <TabRoot title="Agents" action={<NewAgent size={40} />}>
      <Body pane={false} selected={null} />
    </TabRoot>
  );
}
