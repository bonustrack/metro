import { type ReactNode, useState } from 'react';
import { Column } from '@stage-labs/kit/react-native/column';
import { Row } from '@stage-labs/kit/react-native/row';
import { Badge } from '@stage-labs/kit/react-native/badge';
import { Text } from '@stage-labs/kit/react-native/text';
import type { UserRow } from '@metro-labs/client/api/admin';
import { routeHash } from '@metro-labs/client/route';
import { ErrorState } from '../ui/ErrorState.js';
import { Rows } from '../ui/Group.js';
import { Item } from '../ui/Item.js';
import { PageHeader } from '../ui/PageHeader.js';
import { RowsSkeleton } from '../ui/RowsSkeleton.js';
import { AVATAR_SIZE } from '../ui/sizes.js';
import { listCrumbs } from './crumbs.js';
import { DotWord, USER_DOT, UserMark } from './Marks.js';
import { Stats } from './Stats.js';
import { Cell, Controls, FilterMenu, HeadCell, HeadRow, NoMatch, SearchBox, Table, TableRow, TwoLines, type FilterOption } from './Table.js';
import { BlockDialog, UserMenu, useUserActions, type UserActions } from './UserActions.js';
import { NO_USER_FILTERS, USER_SORT_START, USER_STATE_WORD, filterUsers, userCounts, userName, userSortValue, userState, userTie, type UserFilters, type UserSortKey, type UserState } from '../../lib/admin-people.js';
import { useAdminUsers } from '../../lib/admin-queries.js';
import { agoWords, nextSort, sortRows, timeOf, type SortState } from '../../lib/admin-table.js';
import { useIsNarrow } from '../../lib/media.js';
import { queryError } from '../../lib/queries.js';
import { SHRINK } from '../../lib/style.js';
import { useDocumentTitle } from '../../lib/title.js';
import { useNow } from '../../lib/use-now.js';

const FLEX: Record<UserSortKey, number> = { name: 2.6, status: 1.2, created: 1.2, seen: 1.2 };
const LABEL: Record<UserSortKey, string> = { name: 'User', status: 'Status', created: 'Signed up', seen: 'Last sign-in' };
const COLUMNS: UserSortKey[] = ['name', 'status', 'created', 'seen'];
const STATES: ('all' | UserState)[] = ['all', 'waitlist', 'approved', 'none', 'rejected'];
const STATUS_OPTIONS: FilterOption<'all' | UserState>[] = STATES.map((value) => ({ value, label: value === 'all' ? 'All' : USER_STATE_WORD[value] }));

const userHref = (user: UserRow): string => routeHash({ kind: 'admin-user', id: user.id });

function OperatorBadge({ user }: { user: UserRow }): ReactNode {
  return user.operator ? <Badge label="Operator" color="secondary" variant="soft" size="2xs" /> : null;
}

function UserIdentity({ user }: { user: UserRow }): ReactNode {
  const name = userName(user);
  return (
    <Row align="center" gap={12} minWidth={0}>
      <UserMark name={name} picture={user.picture} />
      <Column weight={1} minWidth={0}>
        <TwoLines top={<Row align="center" gap={8} minWidth={0}><Text size="md" numberOfLines={1} style={SHRINK}>{name}</Text><OperatorBadge user={user} /></Row>} bottom={user.name === null ? null : user.email} />
      </Column>
    </Row>
  );
}

function userCell(key: UserSortKey, user: UserRow, now: number): ReactNode {
  if (key === 'name') return <UserIdentity user={user} />;
  if (key === 'status') return <DotWord color={USER_DOT[userState(user)]} word={USER_STATE_WORD[userState(user)]} />;
  if (key === 'created') return <TwoLines top={agoWords(timeOf(user.createdAt), now)} />;
  return <TwoLines top={agoWords(timeOf(user.lastLoginAt), now)} />;
}

interface ListProps {
  users: UserRow[];
  sort: SortState<UserSortKey>;
  onSort: (key: UserSortKey) => void;
  now: number;
  actions: UserActions;
}

function UserTable({ users, sort, onSort, now, actions }: ListProps): ReactNode {
  return (
    <Table>
      <HeadRow>
        {COLUMNS.map((key) => <HeadCell key={key} label={LABEL[key]} column={key} sort={sort} flex={FLEX[key]} onSort={onSort} />)}
      </HeadRow>
      {users.map((user) => (
        <TableRow key={user.id} href={userHref(user)} label={`Open ${userName(user)}`} menu={<UserMenu user={user} actions={actions} />}>
          {COLUMNS.map((key) => <Cell key={key} flex={FLEX[key]}>{userCell(key, user, now)}</Cell>)}
        </TableRow>
      ))}
    </Table>
  );
}

function UserCards({ users, now }: Pick<ListProps, 'users' | 'now'>): ReactNode {
  return (
    <Rows>
      {users.map((user) => (
        <Item key={user.id} title={userName(user)} subtitle={user.name === null ? undefined : (user.email ?? undefined)} detail={`${USER_STATE_WORD[userState(user)]}${user.operator ? ' · Operator' : ''}`}
          leading={<UserMark name={userName(user)} picture={user.picture} size={AVATAR_SIZE.list} />} value={agoWords(timeOf(user.lastLoginAt), now)} href={userHref(user)} chevron={false} />
      ))}
    </Rows>
  );
}

function UsersFilters({ filters, onChange }: { filters: UserFilters; onChange: (filters: UserFilters) => void }): ReactNode {
  return (
    <Controls>
      <SearchBox value={filters.query} placeholder="Search names or emails" onChange={(query) => { onChange({ ...filters, query }); }} />
      <FilterMenu name="Status" value={filters.status} options={STATUS_OPTIONS} same={(a, b) => a === b} onChange={(status) => { onChange({ ...filters, status }); }} />
    </Controls>
  );
}

function UsersList({ users, now }: { users: UserRow[]; now: number }): ReactNode {
  const narrow = useIsNarrow();
  const actions = useUserActions();
  const [filters, setFilters] = useState<UserFilters>(NO_USER_FILTERS);
  const [sort, setSort] = useState<SortState<UserSortKey>>({ key: 'status', dir: USER_SORT_START.status });
  const shown = sortRows(filterUsers(users, filters), sort, userSortValue, userTie);
  return (
    <>
      <UsersFilters filters={filters} onChange={setFilters} />
      <Column>
        {shown.length === 0 ? <NoMatch text="Nobody matches these filters." /> : null}
        {narrow ? <UserCards users={shown} now={now} /> : <UserTable users={shown} sort={sort} onSort={(key) => { setSort(nextSort(sort, key, USER_SORT_START)); }} now={now} actions={actions} />}
        {actions.error === null || actions.blocking !== null ? null : <Text size="xs" color="danger">{actions.error}</Text>}
      </Column>
      <BlockDialog actions={actions} />
    </>
  );
}

function subtitleOf(users: UserRow[] | undefined, waiting: number): string {
  if (users === undefined) return 'Everyone who signed in to Metro.';
  return waiting === 0 ? `${String(users.length)} people.` : `${String(users.length)} people, ${String(waiting)} waiting for you.`;
}

export function AdminUsers(): ReactNode {
  useDocumentTitle('Users');
  const narrow = useIsNarrow();
  const now = useNow(60_000);
  const { data, error, refetch } = useAdminUsers();
  const counts = userCounts(data ?? [], now);
  const known = data !== undefined;
  return (
    <Column gap={28}>
      <PageHeader title="Users" subtitle={subtitleOf(data, counts.waiting)} crumbs={listCrumbs(narrow)} />
      <Stats stats={[
        { label: 'Users', value: known ? counts.total : null },
        { label: 'Waiting', value: known ? counts.waiting : null, dot: 'white' },
        { label: 'Signed in this week', value: known ? counts.week : null },
        { label: 'Blocked', value: known ? counts.blocked : null, dot: 'danger' },
      ]} />
      {error !== null ? <ErrorState title="Could not list the users" text={queryError(error, 'Metro did not answer.')} onRetry={refetch} /> : null}
      {error === null && data === undefined ? <RowsSkeleton rows={6} /> : null}
      {data === undefined ? null : <UsersList users={data} now={now} />}
    </Column>
  );
}
