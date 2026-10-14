import { type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AgentAvatar } from './AgentAvatar.js';
import { RowDots } from './RowDots.js';
import { dateLabel, Item, Listing } from './AdminLists.js';
import { Badge } from '@stage-labs/kit/react-native/badge';
import { fetchUsers, setUserStatus, type UserRow, type UserStatus } from '@metro-labs/client/api/admin';
import { whenLabel } from '@metro-labs/client/api/when';
import { useDocumentTitle } from '../lib/title.js';

const AVATAR = 32;
const USERS_KEY = ['admin', 'users'];

const STATUS_LABEL: Record<UserStatus, string> = { approved: 'Approved', waitlist: 'Waiting', rejected: 'Rejected' };

function Actions({ user, busy, onSet }: { user: UserRow; busy: boolean; onSet: (status: UserStatus) => void }): ReactNode {
  if (user.operator) return null;
  const set = (status: UserStatus) => (): void => { if (!busy) onSet(status); };
  const items = [
    ...(user.status === 'approved' ? [] : [{ label: 'Approve', onSelect: set('approved') }]),
    ...(user.status === 'rejected' ? [] : [{ label: 'Reject', danger: true, onSelect: set('rejected') }]),
  ];
  return <RowDots items={items} label={`Actions for ${user.name ?? user.email ?? user.id}`} />;
}

function UserItem({ user, busy, onSet }: { user: UserRow; busy: boolean; onSet: (status: UserStatus) => void }): ReactNode {
  const detail = `${user.email ?? user.id} · signed up ${dateLabel(user.createdAt)} · last sign-in ${user.lastLoginAt === null ? 'unknown' : whenLabel(user.lastLoginAt)}`;
  return (
    <Item
      title={user.name ?? user.email ?? user.id}
      detail={detail}
      avatar={<AgentAvatar seed={user.id} src={user.picture} size={AVATAR} />}
      badge={user.status === null ? <Badge label="Not on the waitlist" color="secondary" variant="soft" /> : <Badge label={STATUS_LABEL[user.status]} color={user.status === 'approved' ? 'success' : 'secondary'} variant="soft" />}
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
