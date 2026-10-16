import { type ReactNode } from 'react';
import { Col } from '@stage-labs/kit/react-native/box';
import { Button } from '@stage-labs/kit/react-native/button';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import type { UserRow } from '@metro-labs/client/api/admin';
import { ErrorState } from '../ui/ErrorState.js';
import { Group, Groups } from '../ui/Group.js';
import { Item } from '../ui/Item.js';
import { PageHeader } from '../ui/PageHeader.js';
import { RowsSkeleton } from '../ui/RowsSkeleton.js';
import { StateBlock } from '../ui/StateBlock.js';
import { AVATAR_SIZE } from '../ui/sizes.js';
import { USERS_CRUMB, detailCrumbs } from './crumbs.js';
import { Dot, USER_DOT, UserMark } from './Marks.js';
import { BlockDialog, blockLine, mayApprove, mayBlock, useUserActions, type UserActions } from './UserActions.js';
import { userName, userState, type UserState } from '../../lib/admin-people.js';
import { useAdminUsers } from '../../lib/admin-queries.js';
import { agoWords, timeOf } from '../../lib/admin-table.js';
import { queryError } from '../../lib/queries.js';
import { useTechnicalDetails } from '../../lib/technical.js';
import { useDocumentTitle } from '../../lib/title.js';
import { useNow } from '../../lib/use-now.js';

const STATUS_TITLE: Record<UserState, string> = { approved: 'Approved', waitlist: 'Waiting for approval', rejected: 'Blocked', none: 'Not approved' };

function statusLine(user: UserRow): string {
  const name = userName(user);
  if (user.operator) return 'The operator account. Nobody can change it.';
  if (user.status === 'approved') return `${name} can sign in and create an organization.`;
  if (user.status === 'rejected') return `${name} cannot sign in. Approving lets ${name} in again.`;
  if (user.status === 'waitlist') return `${name} joined the waitlist. Approving lets ${name} sign in and create an organization.`;
  return `${name} gets in only as a member of an organization. Approving lets ${name} create one too.`;
}

const exactDate = (iso: string | null): string | undefined => {
  const at = timeOf(iso);
  return at === null ? undefined : new Date(at).toLocaleString();
};

function Approve({ user, actions }: { user: UserRow; actions: UserActions }): ReactNode {
  const dark = useKitScheme() === 'dark';
  if (!mayApprove(user)) return null;
  return <Button color="secondary" dark={dark} label="Approve" loading={actions.busy} disabled={actions.busy} onPress={() => { actions.approve(user); }} />;
}

function UserGroups({ user, actions, now }: { user: UserRow; actions: UserActions; now: number }): ReactNode {
  const technical = useTechnicalDetails();
  const name = userName(user);
  return (
    <>
      <Group label="Status" error={actions.blocking === null ? actions.error : null}>
        <Item title={STATUS_TITLE[userState(user)]} subtitle={statusLine(user)} leading={<Dot color={USER_DOT[userState(user)]} />} />
      </Group>
      <Group label="Sign-ins" note={technical ? `User id ${user.id}` : undefined}>
        <Item title="Last sign-in" subtitle={exactDate(user.lastLoginAt)} value={agoWords(timeOf(user.lastLoginAt), now)} />
        <Item title="Signed up" subtitle={exactDate(user.createdAt)} value={agoWords(timeOf(user.createdAt), now)} />
      </Group>
      {mayBlock(user) ? (
        <Group label="Danger">
          <Item title={`Block ${name}`} subtitle={blockLine(user)} danger chevron={false} onPress={() => { actions.askBlock(user); }} />
        </Group>
      ) : null}
    </>
  );
}

function UserBody({ user }: { user: UserRow }): ReactNode {
  const now = useNow(60_000);
  const actions = useUserActions();
  const name = userName(user);
  const email = user.email ?? user.id;
  return (
    <Groups>
      <PageHeader title={name} subtitle={`${email} · signed up ${agoWords(timeOf(user.createdAt), now).toLowerCase()}`} crumbs={detailCrumbs(USERS_CRUMB, name)}
        leading={<UserMark name={name} picture={user.picture} size={AVATAR_SIZE.header} />} action={<Approve user={user} actions={actions} />} />
      <UserGroups user={user} actions={actions} now={now} />
      <BlockDialog actions={actions} />
    </Groups>
  );
}

export function UserPage({ id }: { id: string }): ReactNode {
  const { data, error, refetch } = useAdminUsers();
  const user = data?.find((row) => row.id === id);
  useDocumentTitle(user === undefined ? 'User' : userName(user));
  if (user !== undefined) return <UserBody user={user} />;
  return (
    <Groups>
      <PageHeader title="User" crumbs={detailCrumbs(USERS_CRUMB, 'User')} />
      {error !== null ? <ErrorState title="Could not read this person" text={queryError(error, 'Metro did not answer.')} onRetry={refetch} /> : null}
      {error === null && data === undefined ? <Col><RowsSkeleton rows={3} /></Col> : null}
      {data === undefined ? null : <StateBlock icon="user" title="Nobody with this id" text="This person is not on Metro, or the link is wrong." />}
    </Groups>
  );
}
