import { type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { Text } from './ui.js';
import { AgentAvatar } from './AgentAvatar.js';
import { ListHeader } from './ListHeader.js';
import { fetchAllAgents, fetchAllOrganizations } from '../api/admin.js';
import { queryError } from '../api/queries.js';
import { useDocumentTitle } from '../title.js';
import { SHRINK } from '../theme.js';

const AVATAR = 32;
const ROW_PAD_Y = 10;
const LIST_WIDTH = 760;

export const dateLabel = (iso: string | null): string => (iso === null ? 'unknown' : new Date(iso).toLocaleDateString());

interface ItemProps {
  title: string;
  detail: string;
  avatar?: ReactNode;
  badge?: ReactNode;
  trailing?: ReactNode;
}

export function Item({ title, detail, avatar, badge, trailing }: ItemProps): ReactNode {
  const palette = useKitPalette();
  const heading = (
    <Text size="md" weight="semibold" numberOfLines={1}>
      {title}
    </Text>
  );
  return (
    <Row align="center" gap={12} padding={{ y: ROW_PAD_Y }} border={{ bottom: { width: 1, color: palette.border } }}>
      {avatar}
      <Col gap={2} style={SHRINK} flex={1}>
        {badge === undefined ? (
          heading
        ) : (
          <Row gap={8} align="center">
            {heading}
            {badge}
          </Row>
        )}
        <Text size="sm" role="secondary" numberOfLines={1}>
          {detail}
        </Text>
      </Col>
      {trailing}
    </Row>
  );
}

interface ListingProps<T> {
  title: string;
  failed: string;
  rows: T[] | undefined;
  error: Error | null;
  render: (row: T) => ReactNode;
}

export function Listing<T>({ title, failed, rows, error, render }: ListingProps<T>): ReactNode {
  return (
    <Col gap={16} width="100%" maxWidth={LIST_WIDTH}>
      <ListHeader title={title} count={rows?.length} />
      {error === null ? null : (
        <Text size="sm" role="danger">
          {queryError(error, failed)}
        </Text>
      )}
      {rows === undefined ? null : <Col>{rows.map(render)}</Col>}
    </Col>
  );
}

export function AdminOrganizations(): ReactNode {
  useDocumentTitle('Organizations');
  const { data, error } = useQuery({ queryKey: ['admin', 'organizations'], queryFn: fetchAllOrganizations, staleTime: 15_000, retry: false });
  return (
    <Listing
      title="Organizations"
      failed="Could not load the organizations."
      rows={data}
      error={error}
      render={(o) => <Item key={o.id} title={o.name ?? o.id} detail={`${o.slug ?? o.id} · created ${dateLabel(o.createdAt)}`} />}
    />
  );
}

export function AdminAgents(): ReactNode {
  useDocumentTitle('Agents');
  const { data, error } = useQuery({ queryKey: ['admin', 'agents'], queryFn: fetchAllAgents, staleTime: 15_000, retry: false });
  return (
    <Listing
      title="Agents"
      failed="Could not load the agents."
      rows={data}
      error={error}
      render={(a) => (
        <Item
          key={a.id}
          title={a.name ?? a.slug ?? a.host}
          detail={`${a.host} · ${a.organizationName ?? a.owner} · added ${dateLabel(a.addedAt)}`}
          avatar={<AgentAvatar seed={a.host} src={a.avatar} size={AVATAR} />}
        />
      )}
    />
  );
}
