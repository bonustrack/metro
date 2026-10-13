import { type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Col } from '@stage-labs/kit/react-native/box';
import { Text } from '@stage-labs/kit/react-native/text';
import { ListHeader } from './ListHeader.js';
import { ListRow } from './ListRow.js';
import { Loading } from './Loading.js';
import { AgentAvatar } from './AgentAvatar.js';
import { fetchAllOrganizations } from '@metro-labs/client/api/admin';
import { queryError } from '../lib/queries.js';
import { useDocumentTitle } from '../lib/title.js';

export const dateLabel = (iso: string | null): string => (iso === null ? 'unknown' : new Date(iso).toLocaleDateString());

const AVATAR = 32;

interface ItemProps {
  title: string;
  detail: string;
  avatar?: ReactNode;
  badge?: ReactNode;
  trailing?: ReactNode;
}

export function Item({ title, detail, avatar, badge, trailing }: ItemProps): ReactNode {
  return <ListRow title={title} detail={detail} icon={avatar} extra={badge} trailing={trailing} highlight={false} />;
}

interface ListingProps<T> {
  title: string;
  failed: string;
  rows: T[] | undefined;
  error: Error | null;
  render: (row: T) => ReactNode;
}

function ListingBody<T>({ failed, rows, error, render }: Omit<ListingProps<T>, 'title'>): ReactNode {
  if (error !== null) return <Text size="md" role="danger">{queryError(error, failed)}</Text>;
  return rows === undefined ? <Loading /> : <Col>{rows.map(render)}</Col>;
}

export function Listing<T>({ title, failed, rows, error, render }: ListingProps<T>): ReactNode {
  return (
    <Col gap={12} width="100%">
      <ListHeader title={title} rule={false} count={rows?.length} />
      <ListingBody failed={failed} rows={rows} error={error} render={render} />
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
      render={(o) => <Item key={o.id} avatar={<AgentAvatar seed={o.id} size={AVATAR} />} title={o.name ?? o.id} detail={`${o.slug ?? o.id} · created ${dateLabel(o.createdAt)}`} />}
    />
  );
}
