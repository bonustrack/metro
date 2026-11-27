import { createContext, type ReactNode, useContext, useState } from 'react';
import { Button } from '@stage-labs/kit/react-native/button';
import { Column } from '@stage-labs/kit/react-native/column';
import { Row } from '@stage-labs/kit/react-native/row';
import { Text } from '@stage-labs/kit/react-native/text';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { approvalCard } from '@metro-labs/client/api/approval-card';
import type { Approval } from '@metro-labs/client/api/approvals';
import { Everything } from '../home/ApprovalCard.js';
import { Icon } from '../Icon.js';
import { allSides } from '../ui/edges.js';
import { ICON_SIZE } from '../ui/sizes.js';
import { listedApproval, useApprovalLists } from '../../lib/agent-status.js';
import { approvalOfCall, chatApprovalTitle } from '../../lib/chat-connectors.js';
import { useOrgConnectorsQuery } from '../../lib/org-connector-queries.js';
import { queryError } from '../../lib/queries.js';
import { SHRINK } from '../../lib/style.js';

interface ChatBox {
  host: string | null;
  agent: string;
  live: boolean;
  decide: (approval: string, allow: boolean) => Promise<string>;
}

export const ChatBoxContext = createContext<ChatBox>({ host: null, agent: '', live: false, decide: () => Promise.reject(new Error('This chat cannot answer approvals.')) });

interface Answered {
  approval: Approval;
  words: string;
}

function Answers({ busy, failed, onAnswer }: { busy: boolean; failed: string | null; onAnswer: (allow: boolean) => void }): ReactNode {
  return (
    <Column gap={8}>
      <Row gap={10} wrap>
        <Button variant="primary" size="sm" label="Approve and continue" disabled={busy} onPress={() => { onAnswer(true); }} />
        <Button color="secondary" size="sm" label="Deny" disabled={busy} onPress={() => { onAnswer(false); }} />
      </Row>
      {failed === null ? null : <Text size="sm" color="danger">{failed}</Text>}
    </Column>
  );
}

export function ServerApproval({ id, call }: { id: string; call: string }): ReactNode {
  const palette = useKitPalette();
  const box = useContext(ChatBoxContext);
  const read = listedApproval(useApprovalLists(box.host === null ? [] : [box.host], [box.live])[0], box.live, id);
  const listed = read !== null && approvalOfCall(read, call) ? read : null;
  const connectors = useOrgConnectorsQuery();
  const [answered, setAnswered] = useState<Answered | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const approval = answered?.approval ?? listed;
  const title = approval === null ? undefined : chatApprovalTitle(approval, connectors, box.agent);
  if (approval === null || title === undefined) return null;
  const answer = (allow: boolean): void => {
    setBusy(true);
    setFailed(null);
    box
      .decide(approval.id, allow)
      .then((words) => { setAnswered({ approval, words }); })
      .catch((err: unknown) => { setFailed(queryError(err, 'The answer did not reach the agent.')); })
      .finally(() => { setBusy(false); });
  };
  return (
    <Column radius={12} border={allSides(palette.border)} padding={14} gap={10} background={palette.inputBg}>
      <Row align="center" gap={8}>
        <Icon name="hand" size={ICON_SIZE.sm} color={palette.link} />
        <Text size="md" fontWeight="semibold" style={SHRINK}>{title}</Text>
      </Row>
      <Everything rows={approvalCard(approval).everything} />
      {answered === null ? <Answers busy={busy} failed={failed} onAnswer={answer} /> : <Text size="sm" color="secondary">{answered.words}</Text>}
    </Column>
  );
}
