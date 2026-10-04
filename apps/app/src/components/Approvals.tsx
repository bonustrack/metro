import { type ReactNode, useState } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitPalette, useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { useQueryClient } from '@tanstack/react-query';
import { Button } from '@stage-labs/kit/react-native/button';
import { Text } from '@stage-labs/kit/react-native/text';
import { SHRINK } from '../lib/style.js';
import { CountBadge } from './CountBadge.js';
import { decideApproval, type Approval, type Decision } from '@metro-labs/client/api/approvals';
import { queryError, refresh, useApprovalsQuery } from '../lib/queries.js';
import { whenLabel } from '@metro-labs/client/api/when';

const DECIDE_FAILED = 'Could not send your answer.';

const summary = (a: Approval): string =>
  `${a.tool}${a.channel === '' ? '' : ` on ${a.channel}`}${a.preview === '' ? '' : `: ${a.preview}`}`;

function PendingRow({ approval }: { approval: Approval }): ReactNode {
  const palette = useKitPalette();
  const dark = useKitScheme() === 'dark';
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const answer = (decision: Decision): void => {
    setBusy(true);
    setError(null);
    decideApproval(approval.id, decision)
      .then(() => refresh(client, 'approvals'))
      .catch((err: unknown) => {
        setError(queryError(err, DECIDE_FAILED));
      })
      .finally(() => {
        setBusy(false);
      });
  };
  return (
    <Col gap={6} padding={{ y: 10 }} border={{ bottom: { width: 1, color: palette.border } }}>
      <Row justify="between" align="center" gap={12}>
        <Col gap={2} style={SHRINK}>
          <Text size="xs" weight="medium" numberOfLines={2}>{summary(approval)}</Text>
          <Text size="2xs" role="secondary">
            {`${whenLabel(approval.requestedAt)} · id ${approval.id}${approval.inChat ? ' · also asked in the chat' : ''}`}
          </Text>
        </Col>
        <Row gap={8} align="center">
          <Button size="md" color="secondary" dark={dark} disabled={busy} label="Reject" onPress={() => { answer('deny'); }} />
          <Button size="md" dark={dark} disabled={busy} label="Approve" onPress={() => { answer('allow'); }} />
        </Row>
      </Row>
      {error === null ? null : <Text size="2xs" role="danger">{error}</Text>}
    </Col>
  );
}

export function Approvals(): ReactNode {
  const query = useApprovalsQuery();
  if (query.data === undefined || query.data.length === 0) return null;
  return (
    <Col gap={8}>
      <Row gap={8} align="center">
        <Text size="sm" weight="medium">Approvals</Text>
        <CountBadge count={query.data.length} />
      </Row>
      {query.data.map((a) => (
        <PendingRow key={a.id} approval={a} />
      ))}
    </Col>
  );
}
