import { type ReactNode, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Button } from '@stage-labs/kit/react-native/button';
import { Column } from '@stage-labs/kit/react-native/column';
import { Row } from '@stage-labs/kit/react-native/row';
import { Text } from '@stage-labs/kit/react-native/text';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import type { ChatPart } from '@metro-labs/core/chat';
import { HttpError, NotFoundError } from '@metro-labs/client/api/client';
import { decideApproval } from '@metro-labs/client/api/approvals';
import { answerTurn } from '@metro-labs/client/api/chat-turns';
import { baseFromSegment } from '@metro-labs/client/auth/daemon';
import { retryTicket, type Chat, type ChatMessage, type ChatPage as Page } from '@metro-labs/client/api/chats';
import { agentSeed, serverLabel, type Server } from '@metro-labs/client/api/servers';
import { activeAccount } from '@metro-labs/client/auth/account';
import { ErrorState } from '../ui/ErrorState.js';
import { side } from '../ui/edges.js';
import { SkeletonLine } from '../ui/RowsSkeleton.js';
import { Spinner } from '../Spinner.js';
import { StateBlock } from '../ui/StateBlock.js';
import { AgentReply, Thread, type AgentFace } from './ChatMessages.js';
import { ChatMenu } from './ChatMenu.js';
import { ChatBoxContext } from './ServerApproval.js';
import { Composer } from './Composer.js';
import { refreshApprovals } from '../../lib/agent-status.js';
import { chatGate, refreshChat, sendChatMessage, unanswered, useBoxStatus, useChatQuery, type ChatGate } from '../../lib/chat-queries.js';
import { useStickToBottom } from '../../lib/chat-scroll.js';
import { holdGoOn, rememberSend } from '../../lib/chat-sends.js';
import { decidedWords, isShared, sharedWords } from '../../lib/chat-words.js';
import { replyGoing, replyHolds, useLiveTurn, type LiveReply, type LiveTurn, type Pending } from '../../lib/chat-turn.js';
import { logError } from '../../lib/log.js';
import { go } from '../../lib/nav.js';
import { queryError, useServersQuery } from '../../lib/queries.js';
import { useDocumentTitle } from '../../lib/title.js';
import { webOnly } from '../../lib/style.js';
import { useIsNarrow } from '../../lib/media.js';
import { PAGE_PAD, PHONE_PAD } from '../ui/sizes.js';

const faceOf = (server: Server | undefined, fallback: string): AgentFace => ({
  name: server === undefined ? 'Agent' : serverLabel(server),
  seed: server === undefined ? fallback : agentSeed(server),
  avatar: server?.avatar ?? null,
});

const shownLength = (parts: readonly ChatPart[]): number => parts.reduce((n, part) => n + (part.type === 'text' ? part.text.length : 100), 0);

const CHAT_WIDTH = 760;
const CENTERED = { alignSelf: 'center' } as const;
const PLACEHOLDER_WIDTH = 220;

const hostOf = (server: Server | undefined): string | null => (server?.kind === 'box' ? server.host : null);

function TryAgain({ live, onRetry }: { live: LiveTurn; onRetry: () => Promise<void> }): ReactNode {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const retry = (): void => {
    setBusy(true);
    setFailed(null);
    onRetry()
      .catch((err: unknown) => { setFailed(queryError(err, 'The agent could not be reached.')); })
      .finally(() => { setBusy(false); });
  };
  return (
    <Column gap={10} align="start">
      <Text size="sm" color="secondary">{live.phase === 'missing' ? 'The agent has not answered this message.' : (live.error ?? 'The agent could not be reached.')}</Text>
      <Button color="secondary" size="sm" label="Try again" loading={busy} disabled={busy} onPress={retry} />
      {failed === null ? null : <Text size="sm" color="danger">{failed}</Text>}
    </Column>
  );
}

function LiveNote({ live, stopError, onRetry }: { live: LiveTurn; stopError: string | null; onRetry: () => Promise<void> }): ReactNode {
  if (live.phase === 'idle') return <SkeletonLine width={PLACEHOLDER_WIDTH} />;
  if (stopError !== null && replyGoing(live)) return <Text size="sm" color="danger">{stopError}</Text>;
  if (live.phase === 'done' && live.delivery === 'failed') return <Text size="sm" color="secondary">This reply could not be saved on metro.box, so it is gone once you leave this page.</Text>;
  return live.phase === 'missing' || live.phase === 'failed' ? <TryAgain live={live} onRetry={onRetry} /> : null;
}

const TOP_BAR = webOnly({ position: 'sticky', top: 0, zIndex: 3 });

function TopBar({ chat, agent, pad }: { chat: Chat; agent: AgentFace; pad: number }): ReactNode {
  const palette = useKitPalette();
  return (
    <Column background={palette.bg} border={{ bottom: side(palette.border) }} style={TOP_BAR}>
      <Row align="center" gap={12} width="100%" maxWidth={CHAT_WIDTH + 2 * pad} padding={{ x: pad, y: 12 }} style={CENTERED}>
        <Column weight={1} minWidth={0}>
          <Text size="md" fontWeight="semibold" numberOfLines={1}>{chat.title === '' ? 'Chat' : chat.title}</Text>
          <Text size="xs" color="secondary" numberOfLines={1}>{`${agent.name} · ${sharedWords(chat, activeAccount()?.user.id ?? '')}`}</Text>
        </Column>
        <ChatMenu chat={chat} />
      </Row>
    </Column>
  );
}

interface ChatActions {
  send: (text: string) => Promise<void>;
  decide: (approval: string, allow: boolean) => Promise<string>;
  answer: (approval: string, allow: boolean) => Promise<void>;
  retry: () => Promise<void>;
}

function useChatActions(page: Page, host: string | null, pending: ChatMessage | null, live: LiveTurn, again: () => void): ChatActions {
  const client = useQueryClient();
  const { chat } = page;
  const send = async (text: string): Promise<void> => {
    if (host === null) throw new Error('This agent cannot chat yet.');
    await sendChatMessage(client, chat.id, text);
  };
  const decide = async (approval: string, allow: boolean): Promise<string> => {
    if (host === null) throw new Error('This agent cannot chat yet.');
    await decideApproval(approval, allow ? 'allow' : 'deny', baseFromSegment(host));
    refreshApprovals(client, host).catch(logError('chat approvals'));
    if (!allow) return decidedWords(false, null);
    const goOn = `I approved it (${approval}). Go on.`;
    if (pending !== null && replyHolds(live)) {
      holdGoOn(pending.id, goOn);
      return decidedWords(true, null);
    }
    return send(goOn).then(
      () => decidedWords(true, null),
      (err: unknown) => decidedWords(true, queryError(err, 'metro.box did not answer')),
    );
  };
  const answer = async (approval: string, allow: boolean): Promise<void> => {
    if (host === null || pending === null) throw new Error('This reply is over.');
    await answerTurn(host, pending.id, page.ticket, approval, allow);
  };
  const resend = async (message: ChatMessage): Promise<void> => {
    try {
      rememberSend(message.id, await retryTicket(chat.id, message.id), message.text ?? '');
    } catch (err) {
      if (err instanceof HttpError && err.status === 409) await refreshChat(client, chat.id);
      throw err;
    }
  };
  const retry = async (): Promise<void> => {
    if (pending === null) return;
    if (live.again === 'send') await resend(pending);
    again();
  };
  return { send, decide, answer, retry };
}

interface DockProps {
  agent: AgentFace;
  reply: LiveReply;
  watched: boolean;
  gate: ChatGate;
  onSend: (text: string) => Promise<void>;
}

function Dock({ agent, reply, watched, gate, onSend }: DockProps): ReactNode {
  const going = watched && replyGoing(reply.live);
  return (
    <Composer
      placeholder={`Message ${agent.name}`}
      waiting={watched && replyHolds(reply.live)}
      locked={gate.kind === 'wait'}
      blocked={gate.kind === 'closed' ? gate.why : null}
      docked
      onSend={onSend}
      onStop={going ? reply.stop : undefined}
      stopping={reply.stopping}
    />
  );
}

const pendingOf = (message: ChatMessage | null): Pending | null => (message === null ? null : { id: message.id, at: message.at });

interface ConversationProps {
  page: Page;
  server: Server | undefined;
}

function Conversation({ page, server }: ConversationProps): ReactNode {
  const { chat } = page;
  const host = hostOf(server);
  const status = useBoxStatus(host);
  const pending = unanswered(page.messages);
  const [attempt, setAttempt] = useState(0);
  const reply = useLiveTurn(host, chat.id, pendingOf(pending), page.ticket, attempt);
  const watched = pending !== null && host !== null;
  const actions = useChatActions(page, host, pending, reply.live, () => { setAttempt((n) => n + 1); });
  const agent = faceOf(server, chat.agent);
  const pad = useIsNarrow() ? PHONE_PAD : PAGE_PAD;
  useStickToBottom(`${String(page.messages.length)}:${String(shownLength(reply.live.parts))}`);
  return (
    <ChatBoxContext.Provider value={{ host, agent: chat.agent, live: status?.state === 'live', decide: actions.decide }}>
      <Column weight={1}>
        <TopBar chat={chat} agent={agent} pad={pad} />
        <Column weight={1} gap={20} width="100%" maxWidth={CHAT_WIDTH + 2 * pad} padding={{ x: pad, top: 24 }} style={CENTERED}>
          <Column weight={1} gap={28}>
            <Thread messages={page.messages} people={page.people} me={activeAccount()?.user.id ?? ''} group={isShared(chat)} agent={agent} onAnswer={actions.answer} />
            {watched ? (
              <AgentReply
                agent={agent}
                parts={reply.live.parts}
                live={replyGoing(reply.live)}
                settled={reply.live.phase === 'done'}
                state={reply.live.state}
                error={reply.live.error}
                note={<LiveNote live={reply.live} stopError={reply.stopError} onRetry={actions.retry} />}
                onAnswer={actions.answer}
              />
            ) : null}
          </Column>
          <Dock agent={agent} reply={reply} watched={watched} gate={chatGate(server, status)} onSend={actions.send} />
        </Column>
      </Column>
    </ChatBoxContext.Provider>
  );
}

export function CenteredSpinner(): ReactNode {
  const palette = useKitPalette();
  return (
    <Column weight={1} align="center" justify="center" accessibilityLabel="Loading">
      <Spinner color={palette.sub} />
    </Column>
  );
}

function ChatFailure({ error, onRetry }: { error: Error; onRetry: () => unknown }): ReactNode {
  if (error instanceof NotFoundError)
    return <StateBlock icon="chats" title="This chat is not here" text="It was deleted, or it is not shared with you." action={{ label: 'Open your chats', onPress: () => { go({ kind: 'chat-home' }); } }} />;
  return <ErrorState title="Could not open this chat" text={queryError(error, 'metro.box did not answer.')} onRetry={onRetry} />;
}

export function ChatPage({ id }: { id: string }): ReactNode {
  const { data, error, refetch } = useChatQuery(id);
  const { data: servers, error: serversError, refetch: refetchServers } = useServersQuery();
  useDocumentTitle(data?.chat.title ?? 'Chat');
  if (error instanceof NotFoundError || (error !== null && data === undefined)) return <ChatFailure error={error} onRetry={refetch} />;
  if (serversError !== null && servers === undefined) return <ChatFailure error={serversError} onRetry={refetchServers} />;
  if (data === undefined || servers === undefined) return <CenteredSpinner />;
  return <Conversation page={data} server={servers.find((s) => s.id === data.chat.agent)} />;
}
