import { Fragment, type ReactNode } from 'react';
import { Text } from '@stage-labs/kit/react-native/text';
import { agentSeed, type Server } from '@metro-labs/client/api/servers';
import { AgentAvatar } from '../AgentAvatar.js';
import { AvatarDot } from '../ui/AvatarDot.js';
import { AVATAR_SIZE } from '../ui/sizes.js';
import { summaryText, type RuleSummary } from '../../lib/connector-summary.js';
import { CHOICE_WORD, type PermissionChoice } from '../../lib/permission-words.js';
import type { DotTone, Tone } from '../../lib/tone.js';

const CHOICE_TONE: Record<PermissionChoice, Tone> = { allow: 'success', ask: 'default', block: 'danger' };

export function AgentFace({ server, dot, size = AVATAR_SIZE.row }: { server: Server; dot: DotTone | null; size?: number }): ReactNode {
  return (
    <AvatarDot dot={dot} mark={server.kind === 'remote' ? 'plug' : undefined}>
      <AgentAvatar seed={agentSeed(server)} src={server.avatar} size={size} />
    </AvatarDot>
  );
}

export function ChoiceWord({ choice }: { choice: PermissionChoice }): ReactNode {
  return (
    <Text size="xs" role={CHOICE_TONE[choice]}>
      {CHOICE_WORD[choice]}
    </Text>
  );
}

export function SummaryLine({ summary }: { summary: RuleSummary }): ReactNode {
  if (summary.kind !== 'groups') return summaryText(summary);
  return (
    <>
      {summary.parts.map((part, at) => (
        <Fragment key={part.label}>
          {`${at === 0 ? '' : ' · '}${part.label}: `}
          <ChoiceWord choice={part.choice} />
        </Fragment>
      ))}
    </>
  );
}
