import { type ReactNode } from 'react';
import { Column } from '@stage-labs/kit/react-native/column';
import { Text } from '@stage-labs/kit/react-native/text';
import { whenLabel } from '@metro-labs/client/api/when';
import type { Chat } from '@metro-labs/client/api/chats';
import { agentSeed, serverLabel, type Server } from '@metro-labs/client/api/servers';
import { routeHash } from '@metro-labs/client/route';
import { AgentAvatar } from '../AgentAvatar.js';
import { ErrorState } from '../ui/ErrorState.js';
import { Rows } from '../ui/Group.js';
import { Item } from '../ui/Item.js';
import { ListPaneRow } from '../ui/ListPaneRow.js';
import { RoundButton } from '../ui/RoundButton.js';
import { RowsSkeleton } from '../ui/RowsSkeleton.js';
import { AVATAR_SIZE } from '../ui/sizes.js';
import { StateBlock } from '../ui/StateBlock.js';
import { ListPane } from '../shell/ListPane.js';
import { TabRoot } from '../shell/TabRoot.js';
import { ActivityDot } from './ActivityDot.js';
import { useChatsQuery } from '../../lib/chat-queries.js';
import { isShared } from '../../lib/chat-words.js';
import { go } from '../../lib/nav.js';
import { queryError, useServersQuery } from '../../lib/queries.js';
import { useDocumentTitle } from '../../lib/title.js';

const EMPTY = 'Start a chat with one of your agents. It answers here, and you can come back to it any time.';

const newChat = (): void => { go({ kind: 'chat-new' }); };

function NewChatButton(): ReactNode {
  return <RoundButton label="New chat" icon="compose" onPress={newChat} />;
}

function lineOf(chat: Chat, server: Server | undefined): string {
  const who = server === undefined ? 'Agent' : serverLabel(server);
  const when = whenLabel(new Date(chat.updatedAt).toISOString());
  return `${who} · ${when}${isShared(chat) ? ' · Shared' : ''}`;
}

function ChatRow({ chat, servers, pane, selected }: { chat: Chat; servers: Server[]; pane: boolean; selected: boolean }): ReactNode {
  const server = servers.find((s) => s.id === chat.agent);
  const avatar = <AgentAvatar seed={server === undefined ? chat.agent : agentSeed(server)} src={server?.avatar ?? null} size={AVATAR_SIZE.chat} />;
  const href = routeHash({ kind: 'chat', id: chat.id });
  const title = chat.title === '' ? 'Chat' : chat.title;
  const dot = <ActivityDot activity={selected && chat.activity === 'unread' ? null : chat.activity} />;
  if (pane) return <ListPaneRow title={title} line={lineOf(chat, server)} avatar={avatar} mark={chat.pinned ? 'pin' : undefined} trailing={dot} selected={selected} href={href} />;
  return <Item title={title} subtitle={lineOf(chat, server)} leading={avatar} trailing={dot} href={href} />;
}

function Section({ label, chats, servers, pane, selected }: { label: string; chats: Chat[]; servers: Server[]; pane: boolean; selected: string | null }): ReactNode {
  if (chats.length === 0) return null;
  const rows = chats.map((chat) => <ChatRow key={chat.id} chat={chat} servers={servers} pane={pane} selected={chat.id === selected} />);
  return (
    <Column gap={4}>
      <Column padding={pane ? { x: 12, y: 4 } : { y: 4 }}>
        <Text size="xs" color="secondary">{label}</Text>
      </Column>
      {pane ? rows : <Rows>{rows}</Rows>}
    </Column>
  );
}

function Body({ pane, selected }: { pane: boolean; selected: string | null }): ReactNode {
  const { data, error, refetch } = useChatsQuery();
  const agents = useServersQuery();
  const servers = agents.data ?? [];
  if (error !== null && data === undefined)
    return (
      <Column padding={pane ? { x: 12, top: 12 } : undefined}>
        <ErrorState title="Could not load the chats" text={queryError(error, 'metro.box did not answer.')} onRetry={refetch} />
      </Column>
    );
  if (data === undefined || (agents.data === undefined && agents.error === null)) return <RowsSkeleton rows={4} pane={pane} trailing={false} />;
  if (data.length === 0)
    return pane ? (
      <Column padding={{ x: 12, top: 4 }}>
        <Text size="xs" color="secondary">No chat yet.</Text>
      </Column>
    ) : (
      <StateBlock icon="chats" title="No chat yet" text={EMPTY} action={{ label: 'New chat', primary: true, onPress: newChat }} />
    );
  return (
    <Column gap={20}>
      <Section label="Pinned" chats={data.filter((c) => c.pinned)} servers={servers} pane={pane} selected={selected} />
      <Section label="Recent" chats={data.filter((c) => !c.pinned)} servers={servers} pane={pane} selected={selected} />
    </Column>
  );
}

export function ChatList({ pane, selected = null }: { pane: boolean; selected?: string | null }): ReactNode {
  if (pane)
    return (
      <ListPane title="Chats" action={<NewChatButton />}>
        <Body pane selected={selected} />
      </ListPane>
    );
  return <ChatsRoot />;
}

function ChatsRoot(): ReactNode {
  useDocumentTitle('Chats');
  return (
    <TabRoot title="Chats" action={<NewChatButton />}>
      <Body pane={false} selected={null} />
    </TabRoot>
  );
}
