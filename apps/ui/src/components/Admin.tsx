import { type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { Text } from './ui.js';
import { AgentAvatar } from './AgentAvatar.js';
import { ListHeader } from './ListHeader.js';
import { fetchUsers, type UserRow } from '../api/auth.js';
import { whenLabel } from '../api/when.js';
import { queryError } from '../api/queries.js';
import { useDocumentTitle } from '../title.js';
import { SHRINK } from '../theme.js';

const AVATAR = 32;
const ROW_PAD_Y = 10;
const LIST_WIDTH = 720;
const FAILED = 'Could not load the users.';

const dateLabel = (iso: string | null): string => (iso === null ? 'unknown' : new Date(iso).toLocaleDateString());

function UserItem({ user }: { user: UserRow }): ReactNode {
  const palette = useKitPalette();
  const title = user.name ?? user.email ?? user.id;
  const detail = `${user.email ?? user.id} · signed up ${dateLabel(user.createdAt)} · last log in ${user.lastLoginAt === null ? 'unknown' : whenLabel(user.lastLoginAt)}`;
  return (
    <Row align="center" gap={12} padding={{ y: ROW_PAD_Y }} border={{ bottom: { width: 1, color: palette.border } }}>
      <AgentAvatar seed={user.id} src={user.picture} size={AVATAR} />
      <Col gap={2} style={SHRINK}>
        <Text size="md" weight="semibold" numberOfLines={1}>
          {title}
        </Text>
        <Text size="sm" role="secondary" numberOfLines={1}>
          {detail}
        </Text>
      </Col>
    </Row>
  );
}

export function Admin(): ReactNode {
  useDocumentTitle('Admin');
  const { data, error } = useQuery({ queryKey: ['admin', 'users'], queryFn: fetchUsers, staleTime: 15_000, retry: false });
  return (
    <Col gap={16} width="100%" maxWidth={LIST_WIDTH}>
      <ListHeader title="Users" count={data?.length} />
      {error !== null ? (
        <Text size="sm" role="danger">
          {queryError(error, FAILED)}
        </Text>
      ) : data === undefined ? null : (
        <Col>
          {data.map((user) => (
            <UserItem key={user.id} user={user} />
          ))}
        </Col>
      )}
    </Col>
  );
}
