import { type ReactNode, useState } from 'react';
import { Pressable } from 'react-native';
import { Column } from '@stage-labs/kit/react-native/column';
import { Row } from '@stage-labs/kit/react-native/row';
import { Text } from '@stage-labs/kit/react-native/text';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import type { ChatPart, ReplyState } from '@metro-labs/core/chat';
import { personName, type ChatMessage, type ChatPerson } from '@metro-labs/client/api/chats';
import { AgentAvatar } from '../AgentAvatar.js';
import { Spinner } from '../Spinner.js';
import { MessageFiles } from './ChatFiles.js';
import { PartView, type Answer } from './ChatParts.js';
import { clockOf, personOf, replyText, tookWords } from '../../lib/chat-words.js';
import { copyText } from '../../lib/clipboard.js';
import { logError } from '../../lib/log.js';
import { Icon } from '../Icon.js';
import { AVATAR_SIZE, ICON_SIZE } from '../ui/sizes.js';
import { SHRINK } from '../../lib/style.js';
import { useTechnicalDetails } from '../../lib/technical.js';

const BUBBLE_MAX = 560;

export interface AgentFace {
  name: string;
  seed: string;
  avatar: string | null;
}

interface BubbleProps {
  message: ChatMessage;
  author: ChatPerson | undefined;
  mine: boolean;
  group: boolean;
  answered: boolean;
}

function BubbleText({ text }: { text: string | null }): ReactNode {
  if (text === null) return <Text size="lg" color="secondary">This message could not be read.</Text>;
  return text === '' ? null : <Text size="lg" selectable>{text}</Text>;
}

function UserBubble({ message, author, mine, group, answered }: BubbleProps): ReactNode {
  const palette = useKitPalette();
  return (
    <Column align="end" gap={6}>
      <Row align="center" gap={8}>
        {group && !mine ? <AgentAvatar seed={author?.id ?? 'member'} src={author?.picture ?? null} size={24} /> : null}
        {group && !mine ? <Text size="xs" color="secondary">{personName(author)}</Text> : null}
        <Text size="3xs" color="secondary">{clockOf(message.at)}</Text>
      </Row>
      <Column radius={16} padding={{ x: 16, y: 10 }} gap={10} background={palette.inputBg} maxWidth={BUBBLE_MAX}>
        <BubbleText text={message.text} />
        <MessageFiles message={message.id} files={message.files} settled={answered} />
      </Column>
    </Column>
  );
}

const STATE_WORDS: Partial<Record<ReplyState, string>> = { stopped: 'Stopped.', error: 'The agent could not finish this reply.' };

function ReplyEnd({ state, error }: { state: ReplyState | null; error: string | null }): ReactNode {
  const technical = useTechnicalDetails();
  const words = state === null ? undefined : STATE_WORDS[state];
  if (words === undefined) return null;
  return (
    <Column gap={4}>
      <Text size="sm" color={state === 'error' ? 'danger' : 'secondary'}>{words}</Text>
      {technical && error !== null ? <Text size="xs" color="secondary" selectable>{error}</Text> : null}
    </Column>
  );
}

function CopyReply({ text }: { text: string }): ReactNode {
  const palette = useKitPalette();
  const [copied, setCopied] = useState(false);
  const copy = (): void => {
    copyText(text)
      .then((done) => {
        setCopied(done);
        setTimeout(() => { setCopied(false); }, 1_500);
      })
      .catch(logError('chat copy'));
  };
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={copied ? 'Copied' : 'Copy reply'} hitSlop={8} onPress={copy}>
      <Icon name={copied ? 'check' : 'copy'} size={ICON_SIZE.sm} color={palette.sub} />
    </Pressable>
  );
}

function ReplyFooter({ text, took }: { text: string; took: number | null }): ReactNode {
  if (text === '' && took === null) return null;
  return (
    <Row align="center" gap={14}>
      {text === '' ? null : <CopyReply text={text} />}
      {took === null ? null : <Text size="3xs" color="secondary">{tookWords(took)}</Text>}
    </Row>
  );
}

interface ReplyProps {
  agent: AgentFace;
  at?: number;
  parts: ChatPart[];
  live: boolean;
  settled: boolean;
  state: ReplyState | null;
  error: string | null;
  note?: ReactNode;
  footer?: ReactNode;
  onAnswer: Answer;
}

export function AgentReply({ agent, at, parts, live, settled, state, error, note, footer, onAnswer }: ReplyProps): ReactNode {
  const palette = useKitPalette();
  const thinking = live && parts.every((part) => part.type !== 'text' || part.text.trim() === '');
  return (
    <Row align="start" gap={12}>
      <AgentAvatar seed={agent.seed} src={agent.avatar} size={AVATAR_SIZE.chat} />
      <Column weight={1} minWidth={0} gap={12}>
        <Row align="center" gap={8}>
          <Text size="sm" fontWeight="semibold">{agent.name}</Text>
          {at === undefined ? null : <Text size="3xs" color="secondary">{clockOf(at)}</Text>}
        </Row>
        {parts.map((part, index) => (
          <PartView key={`${part.type}-${String(index)}`} part={part} live={live} settled={settled} onAnswer={onAnswer} />
        ))}
        {thinking ? (
          <Row align="center" gap={8}>
            <Spinner color={palette.sub} />
            <Text size="sm" color="secondary" style={SHRINK}>{parts.length === 0 ? 'Thinking' : 'Working'}</Text>
          </Row>
        ) : null}
        <ReplyEnd state={settled ? state : null} error={error} />
        {note}
        {footer}
      </Column>
    </Row>
  );
}

interface ThreadProps {
  messages: ChatMessage[];
  people: ChatPerson[];
  me: string;
  group: boolean;
  agent: AgentFace;
  onAnswer: Answer;
}

export function Thread({ messages, people, me, group, agent, onAnswer }: ThreadProps): ReactNode {
  const replied = new Set(messages.flatMap((m) => (m.replyTo === null ? [] : [m.replyTo])));
  return messages.map((message) =>
    message.role === 'user' ? (
      <UserBubble key={message.id} message={message} author={personOf(people, message.author)} mine={message.author === me} group={group} answered={replied.has(message.id)} />
    ) : (
      <StoredReply key={message.id} message={message} agent={agent} onAnswer={onAnswer} />
    ),
  );
}

function StoredReply({ message, agent, onAnswer }: { message: ChatMessage; agent: AgentFace; onAnswer: Answer }): ReactNode {
  const parts = message.reply?.parts ?? [];
  const footer = <ReplyFooter text={replyText(parts)} took={message.reply?.ms ?? null} />;
  return <AgentReply agent={agent} at={message.at} parts={parts} live={false} settled state={message.reply?.state ?? null} error={message.reply?.error ?? null} footer={footer} onAnswer={onAnswer} />;
}
