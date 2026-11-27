import { type ReactNode, useContext, useState } from 'react';
import { Pressable, StyleSheet } from 'react-native';
import { Button } from '@stage-labs/kit/react-native/button';
import { Column } from '@stage-labs/kit/react-native/column';
import { Row } from '@stage-labs/kit/react-native/row';
import { Text } from '@stage-labs/kit/react-native/text';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import type { ApprovalPart, ChatPart, ToolPart } from '@metro-labs/core/chat';
import { connectorOfKey } from '@metro-labs/client/api/connector-key';
import { Icon } from '../Icon.js';
import { Spinner } from '../Spinner.js';
import { allSides } from '../ui/edges.js';
import { SkeletonBlock, SkeletonLine } from '../ui/RowsSkeleton.js';
import { ICON_SIZE } from '../ui/sizes.js';
import { MarkdownBlock } from '../MarkdownBlock.js';
import { ConnectorFavicon } from '../ConnectorFavicon.js';
import { Everything } from '../home/ApprovalCard.js';
import { FileView } from './ChatFiles.js';
import { ChatBoxContext, ServerApproval } from './ServerApproval.js';
import { connectorCall, waitingApprovals } from '../../lib/chat-connectors.js';
import { useOrgConnectorsQuery } from '../../lib/org-connector-queries.js';
import { approvalAnswer, callFields, prettyInput, toolLabel, toolSummary, type SentAnswer } from '../../lib/chat-words.js';
import { MONO, NO_SHRINK, SHRINK } from '../../lib/style.js';

const TOOL_NAME = StyleSheet.flatten([MONO, NO_SHRINK]);
const LOGO = 24;
const NAME_WIDTH = 80;

export type Answer = (approval: string, allow: boolean) => Promise<void>;

interface PartState {
  live: boolean;
  settled: boolean;
}

function ToolStatus({ part, live, settled }: { part: ToolPart } & PartState): ReactNode {
  const palette = useKitPalette();
  if (part.ok === null) {
    if (live) return <Spinner color={palette.sub} />;
    return settled ? <Icon name="close" size={ICON_SIZE.sm} color={palette.sub} /> : null;
  }
  return <Icon name={part.ok ? 'check' : 'exclamationCircle'} size={ICON_SIZE.sm} color={part.ok ? palette.sub : palette.danger} />;
}

function Detail({ label, text }: { label: string; text: string }): ReactNode {
  const palette = useKitPalette();
  return (
    <Column gap={4}>
      <Text size="xs" color="secondary">{label}</Text>
      <Column radius={8} padding={{ x: 12, y: 10 }} background={palette.inputBg}>
        <Text size="sm" selectable>{text}</Text>
      </Column>
    </Column>
  );
}

interface ToolFace {
  leading: ReactNode;
  tool: string;
  summary: string;
  connector: ReactNode;
}

function useToolFace(part: ToolPart): ToolFace {
  const palette = useKitPalette();
  const { agent } = useContext(ChatBoxContext);
  const read = useOrgConnectorsQuery();
  const call = connectorCall(part.name, part.input);
  if (call === null) return { leading: <Icon name="tool" size={ICON_SIZE.sm} color={palette.sub} />, tool: toolLabel(part.name), summary: toolSummary(part.input), connector: null };
  const tool = `${call.tool}${call.more > 0 ? ` +${String(call.more)}` : ''}`;
  const summary = toolSummary(call.arguments);
  if (read.data === undefined && read.error === null) return { leading: <SkeletonBlock width={LOGO} height={LOGO} radius={6} />, tool, summary, connector: <SkeletonLine width={NAME_WIDTH} /> };
  const connector = read.data === undefined ? undefined : connectorOfKey(read.data.connectors, agent, call.key);
  const leading = connector === undefined ? <Icon name="plug" size={ICON_SIZE.sm} color={palette.sub} /> : <ConnectorFavicon name={connector.name} url={connector.url} size={LOGO} />;
  return { leading, tool, summary, connector: <Text size="sm" fontWeight="semibold" style={NO_SHRINK} numberOfLines={1}>{connector?.name ?? call.key}</Text> };
}

function ToolRow({ part, live, settled }: { part: ToolPart } & PartState): ReactNode {
  const palette = useKitPalette();
  const [open, setOpen] = useState(false);
  const face = useToolFace(part);
  return (
    <Column gap={10}>
      <Column radius={10} border={allSides(palette.border)} padding={{ x: 12, y: 8 }} gap={10}>
        <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} onPress={() => { setOpen((v) => !v); }}>
          <Row align="center" gap={10}>
            {face.leading}
            {face.connector}
            <Text size="sm" fontWeight="semibold" style={TOOL_NAME} numberOfLines={1}>{face.tool}</Text>
            <Text size="sm" color="secondary" numberOfLines={1} style={SHRINK}>{face.summary}</Text>
            <Column weight={1} />
            <ToolStatus part={part} live={live} settled={settled} />
            <Icon name={open ? 'chevronDown' : 'chevronRight'} size={ICON_SIZE.sm} color={palette.sub} />
          </Row>
        </Pressable>
        {open ? (
          <Column gap={10}>
            {part.input === '' ? null : <Detail label="Input" text={prettyInput(part.input)} />}
            {part.result === null ? null : <Detail label={part.ok === false ? 'Error' : 'Result'} text={part.result === '' ? 'No output.' : part.result} />}
          </Column>
        ) : null}
      </Column>
      {waitingApprovals(part.name, part.result).map((id) => <ServerApproval key={id} id={id} call={part.input} />)}
    </Column>
  );
}

function ApprovalCard({ part, live, settled, onAnswer }: { part: ApprovalPart; onAnswer: Answer } & PartState): ReactNode {
  const palette = useKitPalette();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [sent, setSent] = useState<SentAnswer | null>(null);
  const shown = approvalAnswer(part, live, settled, sent);
  const answer = (allow: boolean): void => {
    setBusy(true);
    setFailed(null);
    onAnswer(part.id, allow)
      .then(() => { setSent({ state: part.state, allow }); })
      .catch((err: unknown) => { setFailed(err instanceof Error ? err.message : 'The answer did not reach the agent.'); })
      .finally(() => { setBusy(false); });
  };
  const summary = toolSummary(part.input);
  return (
    <Column radius={12} border={allSides(palette.border)} padding={14} gap={10} background={palette.inputBg}>
      <Row align="center" gap={8}>
        <Icon name="hand" size={ICON_SIZE.sm} color={palette.link} />
        <Text size="md" fontWeight="semibold" style={SHRINK}>{shown.buttons ? 'The agent asks before it runs this' : 'The agent asked before it ran this'}</Text>
      </Row>
      <Text size="sm" style={MONO}>{toolLabel(part.tool)}</Text>
      {summary === '' ? null : <Text size="sm" color="secondary" selectable>{summary}</Text>}
      <Everything rows={callFields(part.input)} />
      {shown.buttons ? (
        <Row gap={10} wrap>
          <Button variant="primary" size="sm" label="Approve" disabled={busy} onPress={() => { answer(true); }} />
          <Button color="secondary" size="sm" label="Deny" disabled={busy} onPress={() => { answer(false); }} />
        </Row>
      ) : (
        <Text size="sm" color="secondary">{shown.words}</Text>
      )}
      {failed === null ? null : <Text size="sm" color="danger">{failed}</Text>}
    </Column>
  );
}

export function PartView({ part, live, settled, onAnswer }: { part: ChatPart; onAnswer: Answer } & PartState): ReactNode {
  const palette = useKitPalette();
  if (part.type === 'text') return part.text.trim() === '' ? null : <MarkdownBlock text={part.text} color={palette.link} linkImages />;
  if (part.type === 'tool') return <ToolRow part={part} live={live} settled={settled} />;
  if (part.type === 'file') return <FileView file={part.file} />;
  return <ApprovalCard part={part} live={live} settled={settled} onAnswer={onAnswer} />;
}
