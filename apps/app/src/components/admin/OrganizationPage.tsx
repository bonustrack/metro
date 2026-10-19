import { type ReactNode } from 'react';
import { Col } from '@stage-labs/kit/react-native/box';
import { Button } from '@stage-labs/kit/react-native/button';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { namedSegment } from '@metro-labs/client/auth/org-segment';
import { AgentAvatar } from '../AgentAvatar.js';
import { AvatarDot } from '../ui/AvatarDot.js';
import { ErrorState } from '../ui/ErrorState.js';
import { Group, Groups } from '../ui/Group.js';
import { Item } from '../ui/Item.js';
import { PageHeader } from '../ui/PageHeader.js';
import { RowsSkeleton } from '../ui/RowsSkeleton.js';
import { StateBlock } from '../ui/StateBlock.js';
import { AVATAR_SIZE } from '../ui/sizes.js';
import { seenWords } from './AgentRows.js';
import { addressOf, agentsWords } from './AdminOrganizations.js';
import { ORGANIZATIONS_CRUMB, detailCrumbs } from './crumbs.js';
import { OrganizationMark } from './Marks.js';
import { useAdminOrganizationRows } from './organization-rows.js';
import { STATE_WORD, type AdminAgent } from '../../lib/admin-agents.js';
import { roleWord, type AdminOrganization } from '../../lib/admin-people.js';
import { agoWords, sortRows } from '../../lib/admin-table.js';
import { shortVersion } from '../../lib/agent-line.js';
import { goHash } from '../../lib/nav.js';
import { queryError } from '../../lib/queries.js';
import { useTechnicalDetails } from '../../lib/technical.js';
import { useDocumentTitle } from '../../lib/title.js';
import { useNow } from '../../lib/use-now.js';

const homeOf = (row: AdminOrganization): string => `#/${namedSegment(row.id, row.slug)}`;

function agentLine(agent: AdminAgent): string {
  const state = STATE_WORD[agent.state];
  return agent.version === null ? state : `${state} · ${shortVersion(agent.version)}`;
}

function AgentItem({ agent, now }: { agent: AdminAgent; now: number }): ReactNode {
  const dot = agent.state === 'online' ? 'success' : agent.state === 'offline' ? 'danger' : null;
  return (
    <Item title={agent.name} subtitle={agentLine(agent)} subtitleTone={agent.state === 'offline' ? 'danger' : 'secondary'} value={agent.member ? seenWords(agent, now) : undefined} valueTone="secondary"
      leading={<AvatarDot dot={dot}><AgentAvatar seed={agent.host} src={agent.avatar} size={AVATAR_SIZE.row} /></AvatarDot>} href={agent.href ?? undefined} />
  );
}

function AgentsGroup({ row, agents, now }: { row: AdminOrganization; agents: AdminAgent[]; now: number }): ReactNode {
  const own = sortRows(agents.filter((agent) => agent.organizationId === row.id), { key: 'name', dir: 'asc' }, (agent) => agent.name, (agent) => agent.key);
  const note = row.member ? undefined : `You are not a member of ${row.name}, so its agents are listed without their status.`;
  return (
    <Group label={`Agents (${String(own.length)})`} note={own.length === 0 ? `${row.name} has no agent yet.` : note}>
      {own.map((agent) => <AgentItem key={agent.key} agent={agent} now={now} />)}
    </Group>
  );
}

function PeopleGroup({ row }: { row: AdminOrganization }): ReactNode {
  if (!row.member) return <Group label="Members and AWS accounts" note={`You are not a member of ${row.name}, so its members and AWS accounts are not shown here.`}>{null}</Group>;
  return (
    <Group label="Members and AWS accounts">
      <Item title="Members, invites and AWS accounts" subtitle={`Opens ${row.name} in Metro`} href={`${homeOf(row)}/organization`} />
    </Group>
  );
}

function OrganizationBody({ row, agents }: { row: AdminOrganization; agents: AdminAgent[] }): ReactNode {
  const now = useNow(60_000);
  const dark = useKitScheme() === 'dark';
  const technical = useTechnicalDetails();
  const created = row.createdAt === null ? '' : ` · created ${agoWords(row.createdAt, now).toLowerCase()}`;
  return (
    <Groups>
      <PageHeader title={row.name} subtitle={`${addressOf(row)}${created}`} crumbs={detailCrumbs(ORGANIZATIONS_CRUMB, row.name)} leading={<OrganizationMark name={row.name} avatar={row.avatar} size={AVATAR_SIZE.header} />}
        action={row.member ? <Button color="secondary" dark={dark} label={`Switch to ${row.name}`} onPress={() => { goHash(homeOf(row)); }} /> : undefined} />
      <Group label="Overview" note={technical ? `Organization id ${row.id}` : undefined}>
        <Item title="Agents" value={row.online === null ? agentsWords(row) : `${agentsWords(row)}, ${String(row.online)} online`} />
        <Item title="You" value={roleWord(row)} />
      </Group>
      <AgentsGroup row={row} agents={agents} now={now} />
      <PeopleGroup row={row} />
    </Groups>
  );
}

export function OrganizationPage({ id }: { id: string }): ReactNode {
  const now = useNow(60_000);
  const { rows, agents, error, refetch } = useAdminOrganizationRows(now);
  const row = rows?.find((organization) => organization.id === id);
  useDocumentTitle(row === undefined ? 'Organization' : row.name);
  if (row !== undefined) return <OrganizationBody row={row} agents={agents} />;
  return (
    <Groups>
      <PageHeader title="Organization" crumbs={detailCrumbs(ORGANIZATIONS_CRUMB, 'Organization')} />
      {error !== null ? <ErrorState title="Could not read this organization" text={queryError(error, 'Metro did not answer.')} onRetry={refetch} /> : null}
      {error === null && rows === undefined ? <Col><RowsSkeleton rows={3} /></Col> : null}
      {rows === undefined ? null : <StateBlock icon="officeBuilding" title="No organization with this id" text="It may have been deleted, or the link is wrong." />}
    </Groups>
  );
}
