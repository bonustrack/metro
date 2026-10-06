import { type ReactNode, useEffect, useState } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { Button } from '@stage-labs/kit/react-native/button';
import { Text } from '@stage-labs/kit/react-native/text';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { namedSegment } from '@metro-labs/client/auth/org-segment';
import { accountScopeIdentity } from '@metro-labs/client/auth/account';
import { type DashboardState } from '@metro-labs/client/api/dashboard';
import { useAllAgents } from '../lib/all-agents.js';
import { useMetroRelease } from '../lib/metro-release.js';
import { useIsNarrow } from '../lib/media.js';
import { useDocumentTitle } from '../lib/title.js';
import { SHRINK } from '../lib/style.js';
import { AllAgentRow } from './AllAgentRow.js';
import { Dropdown } from './Dropdown.js';
import { ListHeader } from './ListHeader.js';
import { PlainSidebar } from './PlainSidebar.js';
import { RouteLink } from './RouteLink.js';
import { Frame } from './Shell.js';

const FILTER_BUTTON = { maxWidth: 240 } as const;

function Columns(): ReactNode {
  return <Row gap={24} align="start" padding={{ bottom: 4 }}>
    <Col flex={2.4} minWidth={0}><Text size="2xs" role="secondary">Agent</Text></Col>
    <Col flex={1.8} minWidth={0}><Text size="2xs" role="secondary">Status / Harness</Text></Col>
    <Col flex={3} minWidth={0}><Text size="2xs" role="secondary">Model / Usage</Text></Col>
    <Col flex={1.6} minWidth={0}><Text size="2xs" role="secondary">Metro</Text></Col>
  </Row>;
}

function InventoryMessages({ state }: { state: DashboardState }): ReactNode {
  const { organizations, loading, error } = state;
  return <>
    {error === null ? null : <Text size="sm" role="danger">{organizations === null ? 'Could not load agents.' : 'Could not refresh agents.'} {error}</Text>}
    {loading && organizations === null ? <Text size="sm" role="secondary">Loading agents…</Text> : null}
    {organizations?.length === 0 ? <Text size="sm" role="secondary">No organizations yet.</Text> : null}
  </>;
}

function ReleaseCheck({ release, now }: { release: ReturnType<typeof useMetroRelease>; now: number }): ReactNode {
  const dark = useKitScheme() === 'dark';
  const data = release.data;
  const stale = data !== undefined && (now - data.checkedAt > 120_000 || data.checkedAt > now);
  const checked = data === undefined ? '' : `Checked ${new Date(data.checkedAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}.`;
  return <Row gap={12} align="center" justify="between" wrap>
    <Col gap={3} flex={1} minWidth={180}>
      <Text size="2xs" role="secondary">{release.isError ? 'Update check failed. Availability is unknown.' : stale ? 'Update check stale. Check again for the latest release.' : data === undefined ? 'Checking for Metro updates…' : `Latest Metro ${data.latest}`}</Text>
      {data === undefined ? null : <Text size="2xs" role="secondary">{checked}{release.isError || stale ? ` Last reported release ${data.latest}.` : ' Checks automatically every minute.'}</Text>}
    </Col>
    <Button label="Check for updates" color="secondary" size="sm" dark={dark} disabled={release.isFetching}
      onPress={() => { release.refetch({ cancelRefetch: false }).catch(() => undefined); }} />
  </Row>;
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
  const filterControl = <Dropdown label="Filter by organization" align="end" button={{ label, color: 'secondary', size: 'sm', style: FILTER_BUTTON, textStyle: SHRINK }} items={options} />;
  return { visibleOrgs, visibleRows, filterControl };
}

export function AllAgents({ onLock }: { onLock: () => void }): ReactNode {
  const state = useAllAgents();
  const release = useMetroRelease();
  const { organizations, rows } = state;
  const { visibleOrgs, visibleRows, filterControl } = useOrganizationFilter(state);
  const narrow = useIsNarrow();
  const [, tick] = useState(0);
  const now = Date.now();
  useDocumentTitle('All agents');
  useEffect(() => {
    const timer = setInterval(() => { tick((value) => value + 1); }, 15_000);
    return () => { clearInterval(timer); };
  }, []);
  return <Frame sidebar={(close) => <PlainSidebar selection={{ kind: 'all-agents' }} onSelect={close} />} onLock={onLock}>
    <Col gap={20} width="100%">
      <ListHeader title="All agents" count={organizations === null ? undefined : visibleRows.length} action={filterControl} />
      <Col gap={20} width="100%" maxWidth={1200}>
        <ReleaseCheck release={release} now={now} />
        <InventoryMessages state={state} />
        {visibleRows.length > 0 ? <Col>
          {narrow ? null : <Columns />}
          {visibleRows.map((row) => <AllAgentRow key={row.key} row={row} now={now} narrow={narrow} release={release.data} releaseFailed={release.isError} />)}
        </Col> : null}
        {visibleOrgs.filter((organization) => organization.agents == null || organization.agents.length === 0).map((organization) => <Col key={organization.id} gap={4} padding={{ y: 12 }}>
          <RouteLink to={`#/${namedSegment(organization.id, organization.slug)}`}><Text size="sm" role="link">{organization.name ?? organization.slug ?? organization.id}</Text></RouteLink>
          <Text size="sm" role="secondary">{organization.agents == null ? 'Agent inventory unavailable.' : 'No agents in this organization.'}</Text>
        </Col>)}
        {rows.length > 0 ? <Text size="2xs" role="secondary">Read-only snapshots. Unreachable agents keep their dated last report.</Text> : null}
      </Col>
    </Col>
  </Frame>;
}
