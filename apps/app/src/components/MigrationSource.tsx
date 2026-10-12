import type { ReactNode } from 'react';
import { Col } from '@stage-labs/kit/react-native/box';
import { Text } from '@stage-labs/kit/react-native/text';
import type { MigrationPlan } from '@metro-labs/client/api/connector-migration';
import { routeHash } from '@metro-labs/client/route';
import { MIGRATION_ISSUES } from './migration-copy.js';
import { TextLink } from './TextLink.js';

export function MigrationSource({ row, destinationId, compact = false }: { row: MigrationPlan['rows'][number]; destinationId: string | null; compact?: boolean }): ReactNode {
  const source = row.source;
  return <Col gap={8}>
    <Text size="2xs" role="secondary">{source.origin ?? 'Address withheld'}</Text>
    {compact ? null : <><Text size="2xs">Current source permission snapshot (omitted rules allow access)</Text>
    <Text size="2xs" selectable>{JSON.stringify(source.policy, null, 2)}</Text>
    <Text size="2xs" role="secondary">Preparation must preserve every read, write, ask and per-tool rule. Unsupported snapshots stay blocked, never replaced with a read-only toggle.</Text></>}
    {source.issues.map((issue) => <Text key={issue} size="2xs" role={issue === 'oauth_sign_in' ? 'secondary' : 'danger'}>{MIGRATION_ISSUES[issue]}</Text>)}
    {row.conflicts.filter((conflict) => conflict.id !== destinationId).map((conflict) => <Col key={conflict.id} gap={4}>
      <Text size="2xs" role={conflict.kind === 'name' ? 'danger' : 'secondary'}>
        {`${conflict.kind === 'name' ? 'Name conflict (the server blocks preparation)' : 'Possible duplicate service'}: ${conflict.name} already exists${conflict.assigned ? ' and is assigned to this agent' : ''}. Nothing is merged or overwritten. Review it before continuing.`}
      </Text>
      <TextLink to={routeHash({ kind: 'org-connector', id: conflict.id })}>Review existing connector</TextLink>
    </Col>)}
  </Col>;
}
