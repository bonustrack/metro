import { type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Row } from '@stage-labs/kit/react-native/box';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Button } from './ui.js';
import { AgentAvatar } from './AgentAvatar.js';
import { dateLabel, Item, Listing } from './AdminLists.js';
import { Pill } from './Pill.js';
import { fetchUsers, setUserStatus, type UserRow, type UserStatus } from '../api/admin.js';
import { whenLabel } from '../api/when.js';
import { useDocumentTitle } from '../title.js';

const AVATAR = 32;
const USERS_KEY = ['admin', 'users'];

const STATUS_LABEL: Record<UserStatus, string> = { approved: 'Approved', waitlist: 'Waiting', rejected: 'Rejected' };

function Actions({ user, busy, onSet }: { user: UserRow; busy: boolean; onSet: (status: UserStatus) => void }): ReactNode {
  const dark = useKitScheme() === 'dark';
  if (user.operator) return null;
  return (
    <Row gap={8}>
      {user.status === 'approved' ? null : <Button size="sm" color="primary" dark={dark} label="Approve" disabled={busy} onPress={() => { onSet('approved'); }} />}
      {user.status === 'rejected' ? null : <Button size="sm" color="secondary" dark={dark} label="Reject" disabled={busy} onPress={() => { onSet('rejected'); }} />}
    </Row>
  );
}

function UserItem({ user, busy, onSet }: { user: UserRow; busy: boolean; onSet: (status: UserStatus) => void }): ReactNode {
  const detail = `${user.email ?? user.id} · signed up ${dateLabel(user.createdAt)} · last sign-in ${user.lastLoginAt === null ? 'unknown' : whenLabel(user.lastLoginAt)}`;
  return (
    <Item
      title={user.name ?? user.email ?? user.id}
      detail={detail}
      avatar={<AgentAvatar seed={user.id} src={user.picture} size={AVATAR} />}
      badge={user.status === null ? <Pill label="Not on the waitlist" /> : <Pill label={STATUS_LABEL[user.status]} variant={user.status === 'approved' ? 'primary' : 'default'} />}
      trailing={<Actions user={user} busy={busy} onSet={onSet} />}
    />
  );
}

export function AdminUsers(): ReactNode {
  useDocumentTitle('Users');
  const client = useQueryClient();
  const { data, error } = useQuery({ queryKey: USERS_KEY, queryFn: fetchUsers, staleTime: 15_000, retry: false });
  const change = useMutation({
    mutationFn: ({ id, status }: { id: string; status: UserStatus }) => setUserStatus(id, status),
    onSettled: () => client.invalidateQueries({ queryKey: USERS_KEY }),
  });
  return (
    <Listing
      title="Users"
      failed="Could not load the users."
      rows={data}
      error={error ?? change.error}
      render={(user) => (
        <UserItem
          key={user.id}
          user={user}
          busy={change.isPending}
          onSet={(status) => {
            change.mutate({ id: user.id, status });
          }}
        />
      )}
    />
  );
}
