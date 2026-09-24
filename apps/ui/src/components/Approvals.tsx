import { type ReactNode, useState } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitPalette, useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { useQueryClient } from '@tanstack/react-query';
import { Button, Text } from './ui.js';
import { SHRINK } from '../theme.js';
import { CountBadge } from './CountBadge.js';
import { Pill } from './Pill.js';
import { decideApproval, splitApprovals, verdictLabel, type Approval, type Decision } from '../api/approvals.js';
import { POLICY_SINCE } from '../api/policy.js';
import { olderThan } from '../api/version.js';
import { queryError, refresh, useApprovalsQuery, useModeQuery } from '../api/queries.js';
import { whenLabel } from '../api/when.js';

const RECENT_SHOWN = 5;
const DECIDE_FAILED = 'Could not send your answer.';

const summary = (a: Approval): string => `${a.tool} on ${a.label}${a.preview === '' ? '' : `: ${a.preview}`}`;

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
          <Text size="md" weight="semibold" numberOfLines={2}>{summary(approval)}</Text>
          <Text size="sm" role="secondary">
            {`${whenLabel(approval.requestedAt)} · id ${approval.id}${approval.inChat ? ' · also asked in the chat' : ''}`}
          </Text>
        </Col>
        <Row gap={8} align="center">
          <Button size="sm" color="secondary" dark={dark} disabled={busy} label="Reject" onPress={() => { answer('reject'); }} />
          <Button size="sm" dark={dark} disabled={busy} label="Approve" onPress={() => { answer('approve'); }} />
        </Row>
      </Row>
      {error === null ? null : <Text size="sm" role="danger">{error}</Text>}
    </Col>
  );
}

function RecentRow({ approval }: { approval: Approval }): ReactNode {
  const palette = useKitPalette();
  const failed = approval.outcome?.ok === false;
  return (
    <Col gap={2} padding={{ y: 8 }} border={{ bottom: { width: 1, color: palette.border } }}>
      <Row gap={8} align="center">
        <Text size="sm" numberOfLines={1} style={SHRINK}>{summary(approval)}</Text>
        <Pill label={verdictLabel(approval)} />
      </Row>
      <Text size="sm" role={failed ? 'danger' : 'secondary'} numberOfLines={2}>
        {failed ? (approval.outcome?.text ?? '') : whenLabel(approval.decidedAt ?? approval.requestedAt)}
      </Text>
    </Col>
  );
}

export function Approvals(): ReactNode {
  const mode = useModeQuery();
  const supported = mode.data !== undefined && !olderThan(mode.data.version, POLICY_SINCE);
  const query = useApprovalsQuery(supported);
  if (!supported || query.data === undefined) return null;
  const { pending, recent } = splitApprovals(query.data);
  if (pending.length === 0 && recent.length === 0) return null;
  return (
    <Col gap={8}>
      <Row gap={8} align="center">
        <Text size="md" weight="semibold">Approvals</Text>
        <CountBadge count={pending.length} />
      </Row>
      {pending.length === 0 ? <Text size="sm" role="secondary">Nothing is waiting for you.</Text> : null}
      {pending.map((a) => (
        <PendingRow key={a.id} approval={a} />
      ))}
      {recent.length === 0 ? null : (
        <Col gap={4}>
          <Text size="sm" role="secondary">Recent decisions</Text>
          {recent.slice(0, RECENT_SHOWN).map((a) => (
            <RecentRow key={a.id} approval={a} />
          ))}
        </Col>
      )}
    </Col>
  );
}
