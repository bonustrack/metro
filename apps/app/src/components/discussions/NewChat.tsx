import { type ReactNode, useState } from 'react';
import { Pressable, StyleSheet } from 'react-native';
import { useQueryClient } from '@tanstack/react-query';
import { Column } from '@stage-labs/kit/react-native/column';
import { Row } from '@stage-labs/kit/react-native/row';
import { Text } from '@stage-labs/kit/react-native/text';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { startChat } from '@metro-labs/client/api/chats';
import { agentSeed, boxesOf, serverLabel, type BoxServer } from '@metro-labs/client/api/servers';
import { activeAccount } from '@metro-labs/client/auth/account';
import { readItem, writeItem } from '@metro-labs/client/platform';
import { AgentAvatar } from '../AgentAvatar.js';
import { Dropdown } from '../Dropdown.js';
import { Icon } from '../Icon.js';
import { useHover } from '../ui/hover.js';
import { Modal, ModalText } from '../Modal.js';
import { Actions } from '../ui/Actions.js';
import { ErrorState } from '../ui/ErrorState.js';
import { ICON_SIZE, PAGE_PAD, PHONE_PAD } from '../ui/sizes.js';
import { StateBlock } from '../ui/StateBlock.js';
import { CenteredSpinner } from './ChatPage.js';
import { Composer } from './Composer.js';
import { controlStyles, EffortAndModel } from './ComposerControls.js';
import { effortFor, keepEffort, type EffortChoice } from '../../lib/chat-effort.js';
import { PeoplePicker, togglePicked } from './PeoplePicker.js';
import { fileInputOf, filesAllowed, type PickedFile } from '../../lib/chat-files.js';
import { chatGate, holdSent, putChat, useBoxStatus } from '../../lib/chat-queries.js';
import { greetingOf } from '../../lib/chat-words.js';
import { useIsNarrow } from '../../lib/media.js';
import { go } from '../../lib/nav.js';
import { queryError, useOrganizationQuery, useServersQuery } from '../../lib/queries.js';
import { hoverColor } from '../../lib/theme.js';
import { useDocumentTitle } from '../../lib/title.js';

const LAST_AGENT = 'metro.chat.agent';
const FORM_WIDTH = 720;
const HOME_ROWS = 2;
const LIFT = 160;

const styles = StyleSheet.create({ greeting: { fontSize: 36, lineHeight: 44, textAlign: 'center' } });

function AgentPicker({ boxes, picked, onPick }: { boxes: BoxServer[]; picked: BoxServer | undefined; onPick: (id: string) => void }): ReactNode {
  const palette = useKitPalette();
  const lit = { backgroundColor: hoverColor(palette) };
  const items = boxes.map((box) => ({ label: serverLabel(box), leading: <AgentAvatar seed={agentSeed(box)} src={box.avatar} size={24} />, selected: box.id === picked?.id, onSelect: () => { onPick(box.id); } }));
  return (
    <Dropdown label="Choose the agent" align="start" items={items} style={controlStyles.control} hoverStyle={lit}>
      {picked === undefined ? null : <AgentAvatar seed={agentSeed(picked)} src={picked.avatar} size={24} />}
      <Text size="sm" fontWeight="semibold">{picked === undefined ? 'Choose an agent' : serverLabel(picked)}</Text>
      <Icon name="chevronDown" size={ICON_SIZE.sm} color={palette.sub} />
    </Dropdown>
  );
}

function PeopleButton({ invited, onPress }: { invited: ReadonlySet<string>; onPress: () => void }): ReactNode {
  const palette = useKitPalette();
  const [hovered, hover] = useHover();
  const frame = StyleSheet.flatten([controlStyles.control, hovered ? { backgroundColor: hoverColor(palette) } : null]);
  const members = useOrganizationQuery().data?.members ?? [];
  const people = members.filter((m) => invited.has(m.userId));
  const first = people[0];
  const words = first === undefined ? 'Add people' : `${first.name ?? first.email ?? 'A member'}${people.length > 1 ? ` +${String(people.length - 1)}` : ''}`;
  return (
    <Pressable accessibilityRole="button" accessibilityLabel="Add people" onPress={onPress} style={frame} {...hover}>
      {first === undefined ? <Icon name="userAdd" size={ICON_SIZE.sm} color={palette.sub} /> : <AgentAvatar seed={first.userId} src={first.picture} size={24} />}
      <Text size="sm" color={first === undefined ? 'secondary' : undefined} numberOfLines={1}>{words}</Text>
    </Pressable>
  );
}

const firstAgent = (boxes: BoxServer[], initial: string | undefined): string | null =>
  [initial, readItem(LAST_AGENT)].find((id) => boxes.some((b) => b.id === id)) ?? boxes[0]?.id ?? null;

const askWords = (server: BoxServer | undefined): string => (server === undefined ? 'Choose an agent below' : `How can ${serverLabel(server)} help?`);

function Start({ boxes, initial }: { boxes: BoxServer[]; initial: string | undefined }): ReactNode {
  const client = useQueryClient();
  const me = activeAccount()?.user;
  const [picked, setPicked] = useState<string | null>(() => firstAgent(boxes, initial));
  const [invited, setInvited] = useState<ReadonlySet<string>>(new Set());
  const [adding, setAdding] = useState(false);
  const [effort, setEffort] = useState<EffortChoice>(null);
  const server = boxes.find((b) => b.id === picked);
  const host = server?.host ?? null;
  const status = useBoxStatus(host);
  const gate = chatGate(server, status);
  const toggle = (id: string): void => { setInvited((now) => togglePicked(now, id)); };
  const send = async (text: string, files: PickedFile[]): Promise<void> => {
    if (server === undefined) throw new Error('Choose an agent first.');
    const started = await startChat(server.id, text, [...invited], files.map(fileInputOf));
    writeItem(LAST_AGENT, server.id);
    keepEffort(started.chat.id, effortFor(status, effort));
    holdSent(started.message, started.ticket, text, files);
    await putChat(client, started.chat);
    go({ kind: 'chat', id: started.chat.id });
  };
  const toolbar = (
    <Row align="center" gap={2} wrap>
      <AgentPicker boxes={boxes} picked={server} onPick={setPicked} />
      <PeopleButton invited={invited} onPress={() => { setAdding(true); }} />
      <EffortAndModel host={host} status={status} effort={effort} onPick={setEffort} />
    </Row>
  );
  return (
    <Column gap={28}>
      <Text accessibilityRole="header" fontWeight="semibold" style={styles.greeting}>{greetingOf(new Date(), me?.name ?? null)}</Text>
      <Composer placeholder={askWords(server)} waiting={false} locked={gate.kind === 'wait'} blocked={gate.kind === 'closed' ? gate.why : null} rows={HOME_ROWS} toolbar={toolbar} attach={gate.kind === 'open' && filesAllowed(status)} autoFocus onSend={send} />
      <Modal title="Add people" open={adding} onClose={() => { setAdding(false); }}>
        <Column gap={16}>
          <ModalText>They can read this chat and write in it.</ModalText>
          <PeoplePicker owner={me?.id ?? ''} picked={invited} toggle={toggle} />
          <Actions error={null} main={{ label: 'Done', onPress: () => { setAdding(false); } }} />
        </Column>
      </Modal>
    </Column>
  );
}

function Centered({ children }: { children: ReactNode }): ReactNode {
  const pad = useIsNarrow() ? PHONE_PAD : PAGE_PAD;
  return (
    <Column weight={1} align="center" justify="center" padding={{ x: pad, top: 40, bottom: LIFT }}>
      <Column width="100%" maxWidth={FORM_WIDTH}>
        {children}
      </Column>
    </Column>
  );
}

export function NewChat({ agent }: { agent?: string }): ReactNode {
  const { data, error, refetch } = useServersQuery();
  useDocumentTitle('Chats');
  if (error !== null && data === undefined) return <ErrorState title="Could not read the agents" text={queryError(error, 'metro.box did not answer.')} onRetry={refetch} />;
  const boxes = data === undefined ? null : boxesOf(data);
  if (boxes?.length === 0)
    return <StateBlock icon="chats" title="No agent can chat yet" text="Chats run on an agent's server. Launch an agent with a server first." action={{ label: 'Open the agents', onPress: () => { go({ kind: 'servers' }); } }} />;
  if (boxes === null) return <CenteredSpinner />;
  return (
    <Centered>
      <Start boxes={boxes} initial={agent} />
    </Centered>
  );
}
