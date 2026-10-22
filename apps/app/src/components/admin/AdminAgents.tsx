import { type ReactNode, useState } from 'react';
import { Col } from '@stage-labs/kit/react-native/box';
import { Button } from '@stage-labs/kit/react-native/button';
import { useKitPalette, useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Icon } from '../Icon.js';
import { ErrorState } from '../ui/ErrorState.js';
import { PageHeader } from '../ui/PageHeader.js';
import { RowsSkeleton } from '../ui/RowsSkeleton.js';
import { ICON_SIZE } from '../ui/sizes.js';
import { AgentDialogs, canUpdate, useAgentActions } from './AgentActions.js';
import { AgentCards, AgentTable } from './AgentRows.js';
import { listCrumbs } from './crumbs.js';
import { Stats } from './Stats.js';
import { Controls, FilterMenu, NoMatch, SearchBox, type FilterOption } from './Table.js';
import {
  AGENT_SORT_START,
  NO_AGENT_FILTERS,
  STATE_WORD,
  agentCounts,
  agentSortValue,
  agentTie,
  filterAgents,
  organizationChoices,
  versionChoices,
  type AdminAgent,
  type AgentFilters,
  type AgentSortKey,
  type StatusFilter,
  type VersionFilter,
} from '../../lib/admin-agents.js';
import { useAdminAgents } from '../../lib/admin-queries.js';
import { nextSort, sortRows, type SortState } from '../../lib/admin-table.js';
import { shortVersion } from '../../lib/agent-line.js';
import { useIsNarrow } from '../../lib/media.js';
import { queryError } from '../../lib/queries.js';
import { useDocumentTitle } from '../../lib/title.js';
import { useNow } from '../../lib/use-now.js';

const TICK_MS = 15_000;
const UNCHECKED_NOTE = 'Not checked: you are not a member of their organization, so Metro cannot read their status, model or version.';
const STATUS_ORDER: StatusFilter[] = ['all', 'online', 'updating', 'offline', 'stopped', 'checking', 'unchecked', 'noserver'];

const statusOptions = (): FilterOption<StatusFilter>[] => STATUS_ORDER.map((value) => ({ value, label: value === 'all' ? 'All' : STATE_WORD[value] }));

const sameVersion = (a: VersionFilter, b: VersionFilter): boolean => a.kind === b.kind && (a.kind !== 'is' || b.kind !== 'is' || a.version === b.version);

function versionOptions(rows: AdminAgent[]): FilterOption<VersionFilter>[] {
  return [
    { label: 'All', value: { kind: 'all' } },
    { label: 'Need an update', value: { kind: 'update' } },
    ...versionChoices(rows).map((version): FilterOption<VersionFilter> => ({ label: shortVersion(version), value: { kind: 'is', version } })),
  ];
}

function organizationOptions(rows: AdminAgent[]): FilterOption<string | null>[] {
  return [{ label: 'All', value: null }, ...organizationChoices(rows).map((choice) => ({ label: choice.name, value: choice.id }))];
}

function UpdateAll({ rows, latest, onPress }: { rows: AdminAgent[]; latest: string | null; onPress: () => void }): ReactNode {
  const palette = useKitPalette();
  const dark = useKitScheme() === 'dark';
  if (rows.length === 0 || latest === null) return null;
  return <Button color="secondary" dark={dark} icon={<Icon name="update" size={ICON_SIZE.md} color={palette.link} />} label={`Update ${String(rows.length)} ${rows.length === 1 ? 'agent' : 'agents'}`} onPress={onPress} />;
}

function AgentFiltersBar({ rows, filters, onChange }: { rows: AdminAgent[]; filters: AgentFilters; onChange: (filters: AgentFilters) => void }): ReactNode {
  return (
    <Controls>
      <SearchBox value={filters.query} placeholder="Search agents, hosts or organizations" onChange={(query) => { onChange({ ...filters, query }); }} />
      <FilterMenu name="Organization" value={filters.organization} options={organizationOptions(rows)} same={(a, b) => a === b} onChange={(organization) => { onChange({ ...filters, organization }); }} />
      <FilterMenu name="Status" value={filters.status} options={statusOptions()} same={(a, b) => a === b} onChange={(status) => { onChange({ ...filters, status }); }} />
      <FilterMenu name="Metro" value={filters.version} options={versionOptions(rows)} same={sameVersion} onChange={(version) => { onChange({ ...filters, version }); }} />
    </Controls>
  );
}

function subtitleOf(rows: AdminAgent[]): string {
  const organizations = new Set(rows.map((row) => row.organizationId)).size;
  return `${String(rows.length)} ${rows.length === 1 ? 'agent' : 'agents'} in ${String(organizations)} ${organizations === 1 ? 'organization' : 'organizations'}.`;
}

function AgentsBody({ rows, loading, error, onRetry, children }: { rows: AdminAgent[]; loading: boolean; error: Error | null; onRetry: () => unknown; children: ReactNode }): ReactNode {
  if (error !== null && rows.length === 0) return <ErrorState title="Could not list the agents" text={queryError(error, 'Metro did not answer.')} onRetry={onRetry} />;
  if (loading && rows.length === 0) return <RowsSkeleton rows={6} />;
  return children;
}

export function AdminAgents(): ReactNode {
  useDocumentTitle('Agents');
  const narrow = useIsNarrow();
  const now = useNow(TICK_MS);
  const { rows, dashboard, everyAgent, latest } = useAdminAgents(now);
  const actions = useAgentActions();
  const [filters, setFilters] = useState<AgentFilters>(NO_AGENT_FILTERS);
  const [sort, setSort] = useState<SortState<AgentSortKey>>({ key: 'status', dir: AGENT_SORT_START.status });
  const counts = agentCounts(rows);
  const shown = sortRows(filterAgents(rows, filters), sort, agentSortValue, agentTie);
  const updatable = rows.filter((row) => canUpdate(row) && actions.notes[row.key] === undefined);
  return (
    <Col gap={28}>
      <PageHeader title="Agents" subtitle={rows.length === 0 ? 'Every agent on Metro, in every organization.' : subtitleOf(rows)} crumbs={listCrumbs(narrow)}
        action={<UpdateAll rows={updatable} latest={latest} onPress={() => { actions.ask({ kind: 'update-all', rows: updatable }); }} />} />
      <Stats stats={[
        { label: 'Agents', value: counts.total },
        { label: 'Online', value: counts.online, dot: 'success' },
        { label: 'Updating', value: counts.updating },
        { label: 'Offline', value: counts.offline, dot: 'danger' },
        { label: 'Need an update', value: counts.needsUpdate },
      ]} />
      <AgentFiltersBar rows={rows} filters={filters} onChange={setFilters} />
      <AgentsBody rows={rows} loading={everyAgent.isPending || dashboard.loading} error={everyAgent.error} onRetry={everyAgent.refetch}>
        {shown.length === 0 ? <NoMatch text="No agent matches these filters." /> : null}
        {narrow ? <AgentCards rows={shown} now={now} actions={actions} /> : <AgentTable rows={shown} sort={sort} onSort={(key) => { setSort(nextSort(sort, key, AGENT_SORT_START)); }} now={now} actions={actions} latest={latest} />}
        {shown.some((row) => !row.member) ? <NoMatch text={UNCHECKED_NOTE} /> : null}
      </AgentsBody>
      <AgentDialogs actions={actions} latest={latest} />
    </Col>
  );
}
