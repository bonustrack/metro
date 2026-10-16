import { type ReactNode } from 'react';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import type { AgentRow, OrganizationSummary, UserRow } from '@metro-labs/client/api/admin';
import { routeHash } from '@metro-labs/client/route';
import { Icon, type IconName } from '../Icon.js';
import { ErrorState } from '../ui/ErrorState.js';
import { Group, Groups } from '../ui/Group.js';
import { Item } from '../ui/Item.js';
import { PageHeader } from '../ui/PageHeader.js';
import { AVATAR_SIZE, ICON_SIZE } from '../ui/sizes.js';
import { overviewCrumbs } from './crumbs.js';
import { UserMark } from './Marks.js';
import { SignupChart, signupTotal } from './SignupChart.js';
import { Stats } from './Stats.js';
import { userName } from '../../lib/admin-people.js';
import { useAdminOrganizations, useAdminUsers, useEveryAgent } from '../../lib/admin-queries.js';
import { agoWords, timeOf } from '../../lib/admin-table.js';
import { useIsNarrow } from '../../lib/media.js';
import { queryError } from '../../lib/queries.js';
import { useDocumentTitle } from '../../lib/title.js';
import { useNow } from '../../lib/use-now.js';

const WEEK_MS = 7 * 24 * 60 * 60_000;
const WAITING_SHOWN = 5;

const newThisWeek = (stamps: (string | null)[], now: number): number => stamps.filter((iso) => { const at = timeOf(iso); return at !== null && now - at < WEEK_MS; }).length;

interface Lists {
  users: UserRow[] | undefined;
  organizations: OrganizationSummary[] | undefined;
  agents: AgentRow[] | undefined;
}

function SectionIcon({ icon }: { icon: IconName }): ReactNode {
  const palette = useKitPalette();
  return <Icon name={icon} size={ICON_SIZE.lg} color={palette.text} />;
}

const countOf = (list: unknown[] | undefined): string | undefined => (list === undefined ? undefined : String(list.length));

function Sections({ lists }: { lists: Lists }): ReactNode {
  const waiting = (lists.users ?? []).filter((user) => user.status === 'waitlist').length;
  return (
    <Group>
      <Item title="Agents" subtitle="Every agent, its status and version" leading={<SectionIcon icon="robot" />} value={countOf(lists.agents)} href={routeHash({ kind: 'admin-agents' })} />
      <Item title="Users" subtitle={waiting === 0 ? 'Everyone who signed in' : `${String(waiting)} waiting for you`} leading={<SectionIcon icon="users" />} value={countOf(lists.users)} href={routeHash({ kind: 'admin-users' })} />
      <Item title="Organizations" subtitle="Every organization and its agents" leading={<SectionIcon icon="officeBuilding" />} value={countOf(lists.organizations)} href={routeHash({ kind: 'admin-organizations' })} />
    </Group>
  );
}

function Waiting({ users, now }: { users: UserRow[]; now: number }): ReactNode {
  const waiting = users.filter((user) => user.status === 'waitlist').sort((a, b) => (timeOf(b.createdAt) ?? 0) - (timeOf(a.createdAt) ?? 0));
  if (waiting.length === 0) return null;
  const more = waiting.length - WAITING_SHOWN;
  return (
    <Group label="Waiting for you" note={more > 0 ? `And ${String(more)} more on the Users page.` : undefined}>
      {waiting.slice(0, WAITING_SHOWN).map((user) => (
        <Item key={user.id} title={userName(user)} subtitle={user.name === null ? undefined : (user.email ?? undefined)} value={agoWords(timeOf(user.createdAt), now)} valueTone="secondary"
          leading={<UserMark name={userName(user)} picture={user.picture} size={AVATAR_SIZE.row} />} href={routeHash({ kind: 'admin-user', id: user.id })} />
      ))}
    </Group>
  );
}

function OverviewStats({ lists, now }: { lists: Lists; now: number }): ReactNode {
  const { users, organizations, agents } = lists;
  return (
    <Stats stats={[
      { label: 'Users', value: users?.length ?? null },
      { label: 'Waiting', value: users === undefined ? null : users.filter((user) => user.status === 'waitlist').length, dot: 'white' },
      { label: 'New users this week', value: users === undefined ? null : newThisWeek(users.map((user) => user.createdAt), now) },
      { label: 'Organizations', value: organizations?.length ?? null },
      { label: 'Agents', value: agents?.length ?? null },
    ]} />
  );
}

export function AdminOverview(): ReactNode {
  const narrow = useIsNarrow();
  useDocumentTitle('Admin');
  const now = useNow(60_000);
  const users = useAdminUsers();
  const organizations = useAdminOrganizations();
  const agents = useEveryAgent();
  const lists: Lists = { users: users.data, organizations: organizations.data, agents: agents.data };
  const error = users.error ?? organizations.error ?? agents.error;
  return (
    <Groups>
      <PageHeader title={narrow ? 'Admin' : 'Overview'} subtitle="Metro at a glance, for the operator." crumbs={overviewCrumbs(narrow)} />
      {narrow ? <Sections lists={lists} /> : null}
      <OverviewStats lists={lists} now={now} />
      {error === null ? null : (
        <ErrorState title="Could not read every number" text={queryError(error, 'Metro did not answer.')} onRetry={() => Promise.all([users.refetch(), organizations.refetch(), agents.refetch()])} />
      )}
      {users.data === undefined ? null : <Waiting users={users.data} now={now} />}
      {users.data === undefined ? null : (
        <Group label={`Sign-ups, last 30 days: ${String(signupTotal(users.data, now))} new`} wide>
          <SignupChart users={users.data} now={now} />
        </Group>
      )}
    </Groups>
  );
}
