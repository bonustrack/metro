import { type ReactNode, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { setUserStatus, type UserRow, type UserStatus } from '@metro-labs/client/api/admin';
import { routeHash } from '@metro-labs/client/route';
import { type MenuItem } from '../Dropdown.js';
import { KebabMenu } from '../KebabMenu.js';
import { AskDialog } from '../settings/AskDialog.js';
import { ADMIN_USERS_KEY } from '../../lib/admin-queries.js';
import { userName } from '../../lib/admin-people.js';
import { goHash } from '../../lib/nav.js';
import { queryError } from '../../lib/queries.js';

export interface UserActions {
  busy: boolean;
  error: string | null;
  blocking: UserRow | null;
  approve: (user: UserRow) => void;
  askBlock: (user: UserRow | null) => void;
  block: (user: UserRow) => void;
}

export const mayApprove = (user: UserRow): boolean => !user.operator && user.status !== 'approved';

export const mayBlock = (user: UserRow): boolean => !user.operator && user.status !== 'rejected';

export function useUserActions(): UserActions {
  const client = useQueryClient();
  const [blocking, setBlocking] = useState<UserRow | null>(null);
  const change = useMutation({
    mutationFn: ({ id, status }: { id: string; status: UserStatus }) => setUserStatus(id, status),
    onSuccess: () => { setBlocking(null); },
    onSettled: () => client.invalidateQueries({ queryKey: ADMIN_USERS_KEY }),
  });
  const set = (user: UserRow, status: UserStatus): void => {
    if (!change.isPending) change.mutate({ id: user.id, status });
  };
  return {
    busy: change.isPending,
    error: change.error === null ? null : queryError(change.error, 'Could not change this person.'),
    blocking,
    approve: (user) => { set(user, 'approved'); },
    askBlock: (user) => {
      change.reset();
      setBlocking(user);
    },
    block: (user) => { set(user, 'rejected'); },
  };
}

function userMenuItems(user: UserRow, actions: UserActions): MenuItem[] {
  return [
    { label: `Open ${userName(user)}`, icon: 'arrowRight', onSelect: () => { goHash(routeHash({ kind: 'admin-user', id: user.id })); } },
    ...(mayApprove(user) ? [{ label: 'Approve', icon: 'checkCircle' as const, onSelect: () => { actions.approve(user); } }] : []),
    ...(mayBlock(user) ? [{ label: `Block ${userName(user)}`, danger: true, onSelect: () => { actions.askBlock(user); } }] : []),
  ];
}

export function UserMenu({ user, actions }: { user: UserRow; actions: UserActions }): ReactNode {
  return <KebabMenu ghost label={`Actions for ${userName(user)}`} items={userMenuItems(user, actions)} />;
}

export const blockLine = (user: UserRow): string => `${userName(user)} can no longer sign in. Their organizations and agents stay.`;

export function BlockDialog({ actions }: { actions: UserActions }): ReactNode {
  const user = actions.blocking;
  if (user === null) return null;
  return (
    <AskDialog open title={`Block ${userName(user)}?`} lines={[blockLine(user)]} action="Block" busy={actions.busy} error={actions.error}
      onClose={() => { actions.askBlock(null); }} onConfirm={() => { actions.block(user); }} />
  );
}
