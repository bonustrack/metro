import { type ReactNode, useState } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { Text } from '@stage-labs/kit/react-native/text';
import { routeHash } from '@metro-labs/client/route';
import { namedSegment } from '@metro-labs/client/auth/org-segment';
import { type MenuItem } from '../Dropdown.js';
import { KebabMenu } from '../KebabMenu.js';
import { ErrorState } from '../ui/ErrorState.js';
import { Rows } from '../ui/Group.js';
import { Item } from '../ui/Item.js';
import { PageHeader } from '../ui/PageHeader.js';
import { RowsSkeleton } from '../ui/RowsSkeleton.js';
import { AVATAR_SIZE } from '../ui/sizes.js';
import { listCrumbs } from './crumbs.js';
import { OrganizationMark } from './Marks.js';
import { Stats, type Stat } from './Stats.js';
import { Cell, Controls, HeadCell, HeadRow, NoMatch, SearchBox, Table, TableRow, TwoLines } from './Table.js';
import {
  ORGANIZATION_SORT_START,
  filterOrganizations,
  organizationCounts,
  organizationSortValue,
  organizationTie,
  roleWord,
  type AdminOrganization,
  type OrganizationSortKey,
} from '../../lib/admin-people.js';
import { useAdminOrganizationRows } from './organization-rows.js';
import { agoWords, nextSort, sortRows, type SortState } from '../../lib/admin-table.js';
import { goHash } from '../../lib/nav.js';
import { useIsNarrow } from '../../lib/media.js';
import { queryError } from '../../lib/queries.js';
import { SHRINK } from '../../lib/style.js';
import { useDocumentTitle } from '../../lib/title.js';
import { useNow } from '../../lib/use-now.js';

const FLEX: Record<OrganizationSortKey, number> = { name: 2.6, agents: 1.2, role: 1.2, created: 1.2 };
const LABEL: Record<OrganizationSortKey, string> = { name: 'Organization', agents: 'Agents', role: 'You', created: 'Created' };
const COLUMNS: OrganizationSortKey[] = ['name', 'agents', 'role', 'created'];

export const organizationHref = (row: AdminOrganization): string => routeHash({ kind: 'admin-organization', id: row.id });

export const addressOf = (row: AdminOrganization): string => `metro.box/${row.slug ?? row.id}`;

export const agentsWords = (row: AdminOrganization): string => `${String(row.agents)} ${row.agents === 1 ? 'agent' : 'agents'}`;

function Identity({ row }: { row: AdminOrganization }): ReactNode {
  return (
    <Row align="center" gap={12} minWidth={0}>
      <OrganizationMark name={row.name} avatar={row.avatar} />
      <Col flex={1} minWidth={0}>
        <TwoLines top={<Text size="md" numberOfLines={1} style={SHRINK}>{row.name}</Text>} bottom={addressOf(row)} />
      </Col>
    </Row>
  );
}

function organizationCell(key: OrganizationSortKey, row: AdminOrganization, now: number): ReactNode {
  if (key === 'name') return <Identity row={row} />;
  if (key === 'agents') return <TwoLines top={String(row.agents)} bottom={row.online === null ? null : `${String(row.online)} online`} />;
  if (key === 'role') return <TwoLines top={roleWord(row)} topTone={row.member ? undefined : 'secondary'} />;
  return <TwoLines top={agoWords(row.createdAt, now)} />;
}

function organizationMenu(row: AdminOrganization): MenuItem[] {
  const open: MenuItem = { label: `Open ${row.name}`, icon: 'arrowRight', onSelect: () => { goHash(organizationHref(row)); } };
  if (!row.member) return [open];
  return [open, { label: `Switch to ${row.name}`, icon: 'officeBuilding', onSelect: () => { goHash(`#/${namedSegment(row.id, row.slug)}`); } }];
}

interface ListProps {
  rows: AdminOrganization[];
  sort: SortState<OrganizationSortKey>;
  onSort: (key: OrganizationSortKey) => void;
  now: number;
}

function OrganizationTable({ rows, sort, onSort, now }: ListProps): ReactNode {
  return (
    <Table>
      <HeadRow>
        {COLUMNS.map((key) => <HeadCell key={key} label={LABEL[key]} column={key} sort={sort} flex={FLEX[key]} onSort={onSort} />)}
      </HeadRow>
      {rows.map((row) => (
        <TableRow key={row.id} href={organizationHref(row)} label={`Open ${row.name}`} menu={<KebabMenu ghost label={`Actions for ${row.name}`} items={organizationMenu(row)} />}>
          {COLUMNS.map((key) => <Cell key={key} flex={FLEX[key]}>{organizationCell(key, row, now)}</Cell>)}
        </TableRow>
      ))}
    </Table>
  );
}

const phoneDetail = (row: AdminOrganization): string =>
  [row.online === null ? agentsWords(row) : `${agentsWords(row)}, ${String(row.online)} online`, roleWord(row)].join(' · ');

function OrganizationCards({ rows }: { rows: AdminOrganization[] }): ReactNode {
  return (
    <Rows>
      {rows.map((row) => (
        <Item key={row.id} title={row.name} subtitle={addressOf(row)} detail={phoneDetail(row)} leading={<OrganizationMark name={row.name} avatar={row.avatar} size={AVATAR_SIZE.list} />} href={organizationHref(row)} chevron={false} />
      ))}
    </Rows>
  );
}

function OrganizationList({ rows, now }: { rows: AdminOrganization[]; now: number }): ReactNode {
  const narrow = useIsNarrow();
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<SortState<OrganizationSortKey>>({ key: 'name', dir: ORGANIZATION_SORT_START.name });
  const shown = sortRows(filterOrganizations(rows, query), sort, organizationSortValue, organizationTie);
  return (
    <>
      <Controls>
        <SearchBox value={query} placeholder="Search organizations" onChange={setQuery} />
      </Controls>
      <Col>
        {shown.length === 0 ? <NoMatch text="No organization matches this search." /> : null}
        {narrow ? <OrganizationCards rows={shown} /> : <OrganizationTable rows={shown} sort={sort} onSort={(key) => { setSort(nextSort(sort, key, ORGANIZATION_SORT_START)); }} now={now} />}
      </Col>
    </>
  );
}

function organizationStats(rows: AdminOrganization[] | undefined): Stat[] {
  const counts = organizationCounts(rows ?? []);
  const value = (count: number): number | null => (rows === undefined ? null : count);
  return [
    { label: 'Organizations', value: value(counts.total) },
    { label: 'Agents', value: value(counts.agents) },
    { label: 'You are in', value: value(counts.member) },
    { label: 'Without agents', value: value(counts.empty) },
  ];
}

export function AdminOrganizations(): ReactNode {
  useDocumentTitle('Organizations');
  const narrow = useIsNarrow();
  const now = useNow(60_000);
  const { rows, error, refetch } = useAdminOrganizationRows(now);
  const counts = organizationCounts(rows ?? []);
  const known = rows !== undefined;
  return (
    <Col gap={28}>
      <PageHeader title="Organizations" subtitle={known ? `${String(counts.total)} organizations, ${String(counts.agents)} agents.` : 'Every organization on Metro.'} crumbs={listCrumbs(narrow)} />
      <Stats stats={organizationStats(rows)} />
      {error !== null ? <ErrorState title="Could not list the organizations" text={queryError(error, 'Metro did not answer.')} onRetry={refetch} /> : null}
      {error === null && rows === undefined ? <RowsSkeleton rows={4} /> : null}
      {rows === undefined ? null : <OrganizationList rows={rows} now={now} />}
    </Col>
  );
}
