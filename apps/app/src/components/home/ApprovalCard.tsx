import { type ReactNode, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Column } from '@stage-labs/kit/react-native/column';
import { Row } from '@stage-labs/kit/react-native/row';
import { Button } from '@stage-labs/kit/react-native/button';
import { Text } from '@stage-labs/kit/react-native/text';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import type { AccountGroup } from '@metro-labs/client/api/accounts';
import { approvalCard, lineTarget, type ApprovalCard as Card } from '@metro-labs/client/api/approval-card';
import { decideApproval, type Approval, type Decision } from '@metro-labs/client/api/approvals';
import type { GroupedTool } from '@metro-labs/client/api/policy';
import { fetchSenderCards } from '@metro-labs/client/api/senders';
import { whenLabel } from '@metro-labs/client/api/when';
import { isApprovalId, routeHash } from '@metro-labs/client/route';
import { ConnectorFavicon } from '../ConnectorFavicon.js';
import { Disclosure } from '../ui/Disclosure.js';
import { Icon } from '../Icon.js';
import { StationIcon } from '../StationIcon.js';
import { TextLink } from '../TextLink.js';
import { SkeletonBlock, SkeletonLine } from '../ui/RowsSkeleton.js';
import { useNamedConnector } from '../../lib/approval-connector.js';
import { accountRow, approvalWhere, othersLine, ruleLine, type NamedConnector } from '../../lib/approval-note.js';
import { DECIDE_FAILED } from '../../lib/approval-page.js';
import { queryError, refresh, useBoxQuery } from '../../lib/queries.js';
import { useIsNarrow } from '../../lib/media.js';
import { SHRINK } from '../../lib/style.js';

const MARK = 24;
const FILE_ICON = 20;
const LABEL_WIDTH = 76;
const MARK_RADIUS = Math.round(MARK / 4);
const WHERE_WIDTH = 140;
const NOTE_WIDTH = 180;
const CARDS_STALE_MS = 5 * 60_000;

export interface ApprovalContext {
  agentId: string;
  groups: AccountGroup[];
  tools: Record<string, GroupedTool[]>;
}

export function ApprovalMark({ card, connector }: { card: Card; connector: NamedConnector | null | undefined }): ReactNode {
  const palette = useKitPalette();
  if (card.station !== null) return <StationIcon station={card.station} size={MARK} />;
  if (card.connector !== null && connector === undefined) return <SkeletonBlock width={MARK} height={MARK} radius={MARK_RADIUS} />;
  if (card.connector !== null) return <ConnectorFavicon name={connector?.name ?? card.connector} url={connector?.url ?? ''} size={MARK} />;
  return <Icon name="hand" size={MARK} color={palette.text} />;
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

function Fields({ rows }: { rows: Card['fields'] }): ReactNode {
  if (rows.length === 0) return null;
  return (
    <Column gap={6} margin={{ top: 20 }}>
      {rows.map((field) => (
        <Row key={field.label} gap={12} align="start">
          <Column width={LABEL_WIDTH}>
            <Text size="md" color="secondary" numberOfLines={1}>
              {field.label}
            </Text>
          </Column>
          <Text size="md" numberOfLines={2} style={SHRINK}>
            {field.value}
          </Text>
        </Row>
      ))}
    </Column>
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
          <Text key={part} size="xs" color="secondary">
            {part}
          </Text>
        ),
      )}
    </Row>
  );
}

function Everything({ card }: { card: Card }): ReactNode {
  if (card.everything.length === 0) return null;
  const names = card.everything.map((row) => row.label).join(', ');
  const rows = card.everything.map((row) => `${row.label}: ${row.value}`).join('\n');
  return (
    <Column margin={{ top: 16 }}>
      <Disclosure summary={`Everything in this call: ${names}`} body={rows} />
    </Column>
  );
}

export type Decide = (decision: Decision) => Promise<void>;

function useBoxDecide(id: string): Decide {
  const client = useQueryClient();
  return async (decision) => {
    await decideApproval(id, decision);
    await refresh(client, 'approvals');
  };
}

function useAnswer(decide: Decide): { busy: boolean; error: string | null; answer: (decision: Decision) => void } {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const answer = (decision: Decision): void => {
    setBusy(true);
    setError(null);
    decide(decision)
      .catch((err: unknown) => {
        setError(queryError(err, DECIDE_FAILED));
      })
      .finally(() => {
        setBusy(false);
      });
  };
  return { busy, error, answer };
}

function Answers({ decide }: { decide: Decide }): ReactNode {
  const { busy, error, answer } = useAnswer(decide);
  return (
    <Column gap={10} margin={{ top: 16 }}>
      <Row gap={12}>
        <Column weight={1}>
          <Button size="lg" color="secondary" fullWidth disabled={busy} label="Deny" onPress={() => { answer('deny'); }} />
        </Column>
        <Column weight={1}>
          <Button size="lg" color="primary" fullWidth disabled={busy} label="Approve" onPress={() => { answer('allow'); }} />
        </Column>
      </Row>
      {error === null ? null : <Text size="md" color="danger">{error}</Text>}
    </Column>
  );
}

interface ApprovalCardProps {
  approval: Approval;
  context: ApprovalContext;
  project: string;
  decide?: Decide;
  connector?: NamedConnector;
}

function Details({ project, id }: { project: string; id: string }): ReactNode {
  if (!isApprovalId(id)) return null;
  return (
    <Column margin={{ top: 16 }}>
      <TextLink to={routeHash({ kind: 'approval', project, id })}>See all details</TextLink>
    </Column>
  );
}

function Where({ where }: { where: string | null | undefined }): ReactNode {
  if (where === undefined) return <SkeletonLine width={WHERE_WIDTH} />;
  if (where === null) return null;
  return (
    <Text size="xs" color="secondary" numberOfLines={1}>
      {where}
    </Text>
  );
}

function Note({ note }: { note: string | undefined }): ReactNode {
  if (note === '') return null;
  return (
    <Column margin={{ top: 20 }}>
      {note === undefined ? (
        <SkeletonLine width={NOTE_WIDTH} />
      ) : (
        <Text size="xs" color="secondary">
          {note}
        </Text>
      )}
    </Column>
  );
}

export function ApprovalCardView({ approval, context, project, decide, connector }: ApprovalCardProps): ReactNode {
  const palette = useKitPalette();
  const narrow = useIsNarrow();
  const boxDecide = useBoxDecide(approval.id);
  const card = approvalCard(approval);
  const named = useNamedConnector(card.connector, connector);
  const others = useOthers(approval, context);
  const naming = card.connector !== null && named === undefined;
  const where = naming ? undefined : approvalWhere(card, context.groups, named);
  const note = naming ? undefined : [ruleLine(card, approval.tool, context.groups, context.tools, named), others].filter((part) => part !== null).join(' ');
  const rows = approval.requestedBy === null ? card.fields : [{ label: 'Asked by', value: approval.requestedBy }, ...card.fields];
  return (
    <Column surface="raised" radius={16} padding={narrow ? 20 : 24} accessibilityLabel={`Approval: ${card.title}`}>
      <Row align="start" gap={12}>
        <ApprovalMark card={card} connector={named} />
        <Column weight={1} minWidth={0} gap={2}>
          <Text size="md" fontWeight="semibold" numberOfLines={2}>
            {card.title}
          </Text>
          <Where where={where} />
        </Column>
        <Text size="xs" color="secondary" numberOfLines={1}>
          {whenLabel(approval.requestedAt)}
        </Text>
      </Row>
      <Fields rows={rows} />
      {card.body === null ? null : (
        <Column margin={{ top: 16 }}>
          <Text size="md" color={palette.text} numberOfLines={3}>
            {card.body}
          </Text>
        </Column>
      )}
      <Attachment card={card} />
      <Everything card={card} />
      <Note note={note} />
      <Details project={project} id={approval.id} />
      <Answers decide={decide ?? boxDecide} />
    </Column>
  );
}
