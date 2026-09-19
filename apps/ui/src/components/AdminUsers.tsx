import { type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitPalette, useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Text, Button } from './ui.js';
import { AgentAvatar } from './AgentAvatar.js';
import { ListHeader } from './ListHeader.js';
import { Pill } from './Pill.js';
import { fetchUsers, setUserStatus, type UserRow, type UserStatus } from '../api/admin.js';
import { whenLabel } from '../api/when.js';
import { queryError } from '../api/queries.js';
import { useDocumentTitle } from '../title.js';
import { SHRINK } from '../theme.js';

const AVATAR = 32;
const ROW_PAD_Y = 10;
const LIST_WIDTH = 760;
const FAILED = 'Could not load the users.';
const USERS_KEY = ['admin', 'users'];

const STATUS_LABEL: Record<UserStatus, string> = { approved: 'Approved', waitlist: 'Waiting', rejected: 'Rejected' };

const dateLabel = (iso: string | null): string => (iso === null ? 'unknown' : new Date(iso).toLocaleDateString());

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
  const palette = useKitPalette();
  const title = user.name ?? user.email ?? user.id;
  const detail = `${user.email ?? user.id} · signed up ${dateLabel(user.createdAt)} · last sign-in ${user.lastLoginAt === null ? 'unknown' : whenLabel(user.lastLoginAt)}`;
  return (
    <Row align="center" gap={12} padding={{ y: ROW_PAD_Y }} border={{ bottom: { width: 1, color: palette.border } }}>
      <AgentAvatar seed={user.id} src={user.picture} size={AVATAR} />
      <Col gap={2} style={SHRINK} flex={1}>
        <Row gap={8} align="center">
          <Text size="md" weight="semibold" numberOfLines={1}>
            {title}
          </Text>
          {user.status === null ? <Pill label="Not on the waitlist" /> : <Pill label={STATUS_LABEL[user.status]} variant={user.status === 'approved' ? 'primary' : 'default'} />}
        </Row>
        <Text size="sm" role="secondary" numberOfLines={1}>
          {detail}
        </Text>
      </Col>
      <Actions user={user} busy={busy} onSet={onSet} />
    </Row>
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
  const failure = error ?? change.error;
  return (
    <Col gap={16} width="100%" maxWidth={LIST_WIDTH}>
      <ListHeader title="Users" count={data?.length} />
      {failure !== null ? (
        <Text size="sm" role="danger">
          {queryError(failure, FAILED)}
        </Text>
      ) : null}
      {data === undefined ? null : (
        <Col>
          {data.map((user) => (
            <UserItem
              key={user.id}
              user={user}
              busy={change.isPending}
              onSet={(status) => {
                change.mutate({ id: user.id, status });
              }}
            />
          ))}
        </Col>
      )}
    </Col>
  );
}
