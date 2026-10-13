import { type ReactNode, useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { Text } from '@stage-labs/kit/react-native/text';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { namedSegment } from '@metro-labs/client/auth/org-segment';
import { accountScopeIdentity } from '@metro-labs/client/auth/account';
import { type DashboardRow, type DashboardState } from '@metro-labs/client/api/dashboard';
import { updateAgentIn } from '@metro-labs/client/api/update';
import { fetchAllAgents, type AgentRow } from '@metro-labs/client/api/admin';
import type { OrganizationRow } from '@metro-labs/client/api/auth';
import { useAllAgents } from '../lib/all-agents.js';
import { useMetroRelease } from '../lib/metro-release.js';
import { useIsNarrow } from '../lib/media.js';
import { useDocumentTitle } from '../lib/title.js';
import { queryError, refreshServers } from '../lib/queries.js';
import { SHRINK } from '../lib/style.js';
import { AGENT_COLUMNS, AllAgentRow, MENU_WIDTH } from './AllAgentRow.js';
import { AgentAvatar } from './AgentAvatar.js';
import { DeleteDialog } from './DeleteServer.js';
import { side } from './ui/edges.js';
import { dateLabel } from './AdminLists.js';
import { Dropdown, type MenuItem } from './Dropdown.js';
import { RowDots } from './RowDots.js';
import { ListHeader } from './ListHeader.js';
import { Loading } from './Loading.js';
import { RouteLink } from './RouteLink.js';

const FILTER_BUTTON = { maxWidth: 240 } as const;
const OTHER_AVATAR = 32;
const MENU_SPACE = StyleSheet.create({ menu: { width: MENU_WIDTH, alignItems: 'flex-end' } }).menu;

function Columns(): ReactNode {
  const palette = useKitPalette();
  const head = (label: string, flex: number): ReactNode => <Col flex={flex} minWidth={0}><Text size="md" role="secondary">{label}</Text></Col>;
  return <Row gap={24} align="center" padding={{ bottom: 8 }} border={{ bottom: side(palette.border) }}>
    {head('Agent', AGENT_COLUMNS.agent)}
    {head('Status', AGENT_COLUMNS.status)}
    {head('Model', AGENT_COLUMNS.model)}
    {head('Metro', AGENT_COLUMNS.metro)}
    <View style={MENU_SPACE} />
  </Row>;
}

function InventoryMessages({ state }: { state: DashboardState }): ReactNode {
  const { organizations, loading, error } = state;
  return <>
    {error === null ? null : <Text size="sm" role="danger">{organizations === null ? 'Could not load agents.' : 'Could not refresh agents.'} {error}</Text>}
    {loading && organizations === null ? <Loading /> : null}
    {organizations?.length === 0 ? <Text size="sm" role="secondary">No organizations yet.</Text> : null}
  </>;
}

function useOrganizationFilter({ organizations, rows }: DashboardState) {
  const scope = accountScopeIdentity();
  const [filter, setFilter] = useState<{ scope: number; id: string | null }>({ scope, id: null });
  const selected = filter.scope === scope ? organizations?.find((org) => org.id === filter.id) : undefined;
  useEffect(() => {
    if (filter.scope !== scope || (filter.id !== null && organizations !== null && selected === undefined)) setFilter({ scope, id: null });
  }, [filter.id, filter.scope, organizations, scope, selected]);
  const visibleOrgs = selected === undefined ? organizations ?? [] : [selected];
  const visibleRows = selected === undefined ? rows : rows.filter((row) => row.organization.id === selected.id);
  const options = [{ label: 'All organizations', selected: selected === undefined, onSelect: () => { setFilter({ scope, id: null }); } },
    ...(organizations ?? []).map((org) => {
      const name = org.name ?? org.slug ?? org.id;
      const duplicate = organizations?.some((other) => other.id !== org.id && (other.name ?? other.slug ?? other.id) === name);
      return { label: duplicate === true ? `${name} (${org.slug ?? org.id})` : name, selected: selected?.id === org.id, onSelect: () => { setFilter({ scope, id: org.id }); } };
    })];
  const label = selected === undefined ? 'All organizations' : selected.name ?? selected.slug ?? selected.id;
  const filterControl = <Dropdown label="Filter by organization" align="start" button={{ label, color: 'secondary', size: 'md', style: FILTER_BUTTON, textStyle: SHRINK }} items={options} />;
  return { visibleOrgs, visibleRows, filterControl, filtered: selected !== undefined };
}

const AGENTS_KEY = ['admin', 'agents'];

interface Doomed {
  id: string;
  label: string;
}

function RowMenu({ label, onUpdate, onDelete }: { label: string; onUpdate?: () => void; onDelete: () => void }): ReactNode {
  const items: MenuItem[] = [
    ...(onUpdate === undefined ? [] : [{ label: 'Update', onSelect: onUpdate }]),
    { label: 'Delete', danger: true, onSelect: onDelete },
  ];
  return <RowDots items={items} label={`Actions for ${label}`} />;
}

function useUpdates(): { notes: Record<string, string>; update: (row: DashboardRow) => void } {
  const [notes, setNotes] = useState<Record<string, string>>({});
  const note = (id: string, text: string): void => { setNotes((current) => ({ ...current, [id]: text })); };
  const update = (row: DashboardRow): void => {
    note(row.agent.id, 'Updating…');
    updateAgentIn(row.organization.id, row.agent.host)
      .then((result) => {
        if (!result.updated) note(row.agent.id, 'No update yet, try again soon');
        else note(row.agent.id, result.restarting ? `Restarting on ${result.version}` : `${result.version} installed, restart needed`);
      })
      .catch((err: unknown) => { note(row.agent.id, `Update failed: ${queryError(err, 'unknown error')}`); });
  };
  return { notes, update };
}

function OtherRow({ agent, onDelete }: { agent: AgentRow; onDelete: (doomed: Doomed) => void }): ReactNode {
  const palette = useKitPalette();
  const label = agent.name ?? agent.slug ?? agent.host;
  return <Row gap={12} align="center" padding={{ y: 12 }} border={{ bottom: side(palette.border) }}>
    <AgentAvatar seed={agent.host} src={agent.avatar} size={OTHER_AVATAR} />
    <Col gap={2} flex={1} minWidth={0}>
      <Text size="sm" weight="semibold" numberOfLines={1} style={SHRINK}>{label}</Text>
      <Text size="xs" role="secondary" numberOfLines={1}>{`${agent.organizationName ?? agent.owner} · added ${dateLabel(agent.addedAt)}`}</Text>
    </Col>
    <View style={MENU_SPACE}><RowMenu label={label} onDelete={() => { onDelete({ id: agent.id, label }); }} /></View>
  </Row>;
}

function OtherAgents({ agents, onDelete }: { agents: AgentRow[]; onDelete: (doomed: Doomed) => void }): ReactNode {
  if (agents.length === 0) return null;
  return <Col gap={4}>
    <Text size="md" role="secondary">Other organizations</Text>
    <Col>{agents.map((agent) => <OtherRow key={agent.id} agent={agent} onDelete={onDelete} />)}</Col>
  </Col>;
}

interface TableProps {
  rows: DashboardRow[];
  now: number;
  narrow: boolean;
  release: ReturnType<typeof useMetroRelease>;
  notes: Record<string, string>;
  onUpdate: (row: DashboardRow) => void;
  onDelete: (doomed: Doomed) => void;
}

function AgentTable({ rows, now, narrow, release, notes, onUpdate, onDelete }: TableProps): ReactNode {
  if (rows.length === 0) return null;
  return <Col>
    {narrow ? null : <Columns />}
    {rows.map((row) => {
      const label = row.agent.name ?? row.agent.host;
      return <AllAgentRow key={row.key} row={row} now={now} narrow={narrow} release={release.data} releaseFailed={release.isError} note={notes[row.agent.id]}
        menu={<RowMenu label={label} onUpdate={() => { onUpdate(row); }} onDelete={() => { onDelete({ id: row.agent.id, label }); }} />} />;
    })}
  </Col>;
}

function EmptyOrganizations({ organizations }: { organizations: OrganizationRow[] }): ReactNode {
  return organizations.filter((organization) => organization.agents == null || organization.agents.length === 0).map((organization) => <Row key={organization.id} gap={4} align="center" wrap>
    <RouteLink to={`#/${namedSegment(organization.id, organization.slug)}`}><Text size="md" role="link">{organization.name ?? organization.slug ?? organization.id}</Text></RouteLink>
    <Text size="md" role="secondary">{organization.agents == null ? '· agent list unavailable' : '· no agents'}</Text>
  </Row>);
}

function FilterLine({ count, children }: { count: number; children: ReactNode }): ReactNode {
  return count > 1 ? <Row>{children}</Row> : null;
}

function useTick(): number {
  const [, tick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => { tick((value) => value + 1); }, 15_000);
    return () => { clearInterval(timer); };
  }, []);
  return Date.now();
}

export function AdminAgents(): ReactNode {
  const state = useAllAgents();
  const release = useMetroRelease();
  const client = useQueryClient();
  const everyAgent = useQuery({ queryKey: AGENTS_KEY, queryFn: fetchAllAgents, staleTime: 15_000, retry: false });
  const [deleting, setDeleting] = useState<Doomed | null>(null);
  const { notes, update } = useUpdates();
  const { organizations, rows } = state;
  const { visibleOrgs, visibleRows, filterControl, filtered } = useOrganizationFilter(state);
  const narrow = useIsNarrow();
  const now = useTick();
  useDocumentTitle('Agents');
  const mine = new Set(rows.map((row) => row.agent.id));
  const others = filtered || organizations === null ? [] : (everyAgent.data ?? []).filter((a) => !mine.has(a.id));
  return <Col gap={12} width="100%">
    <ListHeader title="Agents" rule={false} count={organizations === null ? undefined : visibleRows.length + others.length} />
    <InventoryMessages state={state} />
    {everyAgent.error === null ? null : <Text size="md" role="danger">{queryError(everyAgent.error, 'Could not load the agents of other organizations.')}</Text>}
    <FilterLine count={organizations?.length ?? 0}>{filterControl}</FilterLine>
    <AgentTable rows={visibleRows} now={now} narrow={narrow} release={release} notes={notes} onUpdate={update} onDelete={setDeleting} />
    <EmptyOrganizations organizations={visibleOrgs} />
    <OtherAgents agents={others} onDelete={setDeleting} />
    {deleting === null ? null : <DeleteDialog id={deleting.id} label={deleting.label} scope="admin"
      onDeleted={async () => {
        await Promise.all([client.invalidateQueries({ queryKey: AGENTS_KEY }), refreshServers(client)]);
        setDeleting(null);
      }}
      onClose={() => { setDeleting(null); }} />}
  </Col>;
}
