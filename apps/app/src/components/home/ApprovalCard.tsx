import { type ReactNode, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { Button } from '@stage-labs/kit/react-native/button';
import { Text } from '@stage-labs/kit/react-native/text';
import { useKitPalette, useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { flattenAccounts, type AccountGroup } from '@metro-labs/client/api/accounts';
import { approvalCard, lineTarget, type ApprovalCard as Card } from '@metro-labs/client/api/approval-card';
import { decideApproval, type Approval, type Decision } from '@metro-labs/client/api/approvals';
import { stationLabel } from '@metro-labs/client/api/attach';
import type { GroupedTool } from '@metro-labs/client/api/policy';
import { fetchSenderCards } from '@metro-labs/client/api/senders';
import { whenLabel } from '@metro-labs/client/api/when';
import { ConnectorFavicon } from '../ConnectorFavicon.js';
import { Icon } from '../Icon.js';
import { StationIcon } from '../StationIcon.js';
import { accountRow, othersLine, ruleLine } from '../../lib/approval-note.js';
import { accountName } from '../../lib/setup-steps.js';
import { queryError, refresh, useBoxQuery } from '../../lib/queries.js';
import { useIsNarrow } from '../../lib/media.js';
import { SHRINK } from '../../lib/style.js';

const MARK = 24;
const FILE_ICON = 20;
const LABEL_WIDTH = 76;
const CARDS_STALE_MS = 5 * 60_000;
const DECIDE_FAILED = 'Could not send your answer.';

export interface ApprovalContext {
  agentId: string;
  groups: AccountGroup[];
  tools: Record<string, GroupedTool[]>;
}

function Mark({ card }: { card: Card }): ReactNode {
  const palette = useKitPalette();
  if (card.station !== null) return <StationIcon station={card.station} size={MARK} />;
  if (card.connector !== null) return <ConnectorFavicon name={card.connector} url="" size={MARK} />;
  return <Icon name="hand" size={MARK} color={palette.text} />;
}

function whereOf(card: Card, groups: AccountGroup[]): string | null {
  if (card.connector !== null) return card.connector;
  const account = flattenAccounts(groups).find((a) => a.station === card.station && a.row.id === card.account);
  if (account !== undefined) return accountName(account);
  if (card.station === null) return null;
  return [stationLabel(card.station), card.account ?? ''].filter((part) => part !== '').join(' · ');
}

function promptAccount(approval: Approval): { station: string; account: string } {
  const prompt = lineTarget(approval.line);
  return { station: prompt?.station ?? '', account: prompt?.account ?? '' };
}

function useOthers(approval: Approval, context: ApprovalContext): string | null {
  const { station, account } = promptAccount(approval);
  const approvers = accountRow(context.groups, station, account)?.approvers ?? [];
  const enabled = approvers.length > 0 && context.agentId !== '';
  const cards = useBoxQuery(['sender-cards', context.agentId, station, account, 'approvers'], () => fetchSenderCards(context.agentId, station, account), {
    enabled,
    staleTime: CARDS_STALE_MS,
    retry: false,
  });
  if (!enabled || cards.isPending) return null;
  return othersLine(approvers, cards.data ?? []);
}

function Fields({ card }: { card: Card }): ReactNode {
  if (card.fields.length === 0) return null;
  return (
    <Col gap={6} margin={{ top: 20 }}>
      {card.fields.map((field) => (
        <Row key={field.label} gap={12} align="start">
          <Col width={LABEL_WIDTH}>
            <Text size="md" role="secondary" numberOfLines={1}>
              {field.label}
            </Text>
          </Col>
          <Text size="md" numberOfLines={2} style={SHRINK}>
            {field.value}
          </Text>
        </Row>
      ))}
    </Col>
  );
}

function Attachment({ card }: { card: Card }): ReactNode {
  const palette = useKitPalette();
  if (card.file === null) return null;
  const extra = card.moreFiles > 0 ? `+${String(card.moreFiles)} more` : null;
  return (
    <Row gap={10} align="center" margin={{ top: 16 }}>
      <Icon name="documentText" size={FILE_ICON} color={palette.text} />
      <Text size="md" numberOfLines={1} style={SHRINK}>
        {card.file.name}
      </Text>
      {[card.file.size, extra].map((part) =>
        part === null ? null : (
          <Text key={part} size="xs" role="secondary">
            {part}
          </Text>
        ),
      )}
    </Row>
  );
}

function useAnswer(id: string): { busy: boolean; error: string | null; answer: (decision: Decision) => void } {
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const answer = (decision: Decision): void => {
    setBusy(true);
    setError(null);
    decideApproval(id, decision)
      .then(() => refresh(client, 'approvals'))
      .catch((err: unknown) => {
        setError(queryError(err, DECIDE_FAILED));
      })
      .finally(() => {
        setBusy(false);
      });
  };
  return { busy, error, answer };
}

function Answers({ id }: { id: string }): ReactNode {
  const dark = useKitScheme() === 'dark';
  const { busy, error, answer } = useAnswer(id);
  return (
    <Col gap={10} margin={{ top: 16 }}>
      <Row gap={12}>
        <Col flex={1}>
          <Button size="lg" color="secondary" dark={dark} fullWidth disabled={busy} label="Deny" onPress={() => { answer('deny'); }} />
        </Col>
        <Col flex={1}>
          <Button size="lg" color="primary" dark={dark} fullWidth disabled={busy} label="Approve" onPress={() => { answer('allow'); }} />
        </Col>
      </Row>
      {error === null ? null : <Text size="md" role="danger">{error}</Text>}
    </Col>
  );
}

export function ApprovalCardView({ approval, context }: { approval: Approval; context: ApprovalContext }): ReactNode {
  const palette = useKitPalette();
  const narrow = useIsNarrow();
  const card = approvalCard(approval);
  const where = whereOf(card, context.groups);
  const others = useOthers(approval, context);
  const note = [ruleLine(card, approval.tool, context.groups, context.tools), others].filter((part) => part !== null).join(' ');
  return (
    <Col surface="raised" radius={16} padding={narrow ? 20 : 24} accessibilityLabel={`Approval: ${card.title}`}>
      <Row align="start" gap={12}>
        <Mark card={card} />
        <Col flex={1} minWidth={0} gap={2}>
          <Text size="md" weight="semibold" numberOfLines={2}>
            {card.title}
          </Text>
          {where === null ? null : (
            <Text size="xs" role="secondary" numberOfLines={1}>
              {where}
            </Text>
          )}
        </Col>
        <Text size="xs" role="secondary" numberOfLines={1}>
          {whenLabel(approval.requestedAt)}
        </Text>
      </Row>
      <Fields card={card} />
      {card.body === null ? null : (
        <Col margin={{ top: 16 }}>
          <Text size="md" color={palette.text} numberOfLines={3}>
            {card.body}
          </Text>
        </Col>
      )}
      <Attachment card={card} />
      {note === '' ? null : (
        <Col margin={{ top: 20 }}>
          <Text size="xs" role="secondary">
            {note}
          </Text>
        </Col>
      )}
      <Answers id={approval.id} />
    </Col>
  );
}
