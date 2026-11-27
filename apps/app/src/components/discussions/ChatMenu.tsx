import { type ReactNode, useState } from 'react';
import { Pressable } from 'react-native';
import { useQueryClient } from '@tanstack/react-query';
import { Column } from '@stage-labs/kit/react-native/column';
import { Row } from '@stage-labs/kit/react-native/row';
import { Text } from '@stage-labs/kit/react-native/text';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { changeChat, deleteChat, pinChat, type Chat, type ChatShared } from '@metro-labs/client/api/chats';
import { DeleteMenu } from '../DeleteMenu.js';
import { type MenuItem } from '../Dropdown.js';
import { Icon, type IconName } from '../Icon.js';
import { KebabMenu } from '../KebabMenu.js';
import { Modal, ModalText } from '../Modal.js';
import { NameModal } from '../NameModal.js';
import { PeoplePicker, togglePicked } from './PeoplePicker.js';
import { Actions } from '../ui/Actions.js';
import { ICON_SIZE } from '../ui/sizes.js';
import { dropChat, putChat, refreshChat } from '../../lib/chat-queries.js';
import { logError } from '../../lib/log.js';
import { go } from '../../lib/nav.js';
import { queryError } from '../../lib/queries.js';
import { selectedColor } from '../../lib/theme.js';

const SHARE_TEXT = 'People who can open this chat can read it and write in it.';

function Choice({ icon, title, line, chosen, onPress }: { icon: IconName; title: string; line: string; chosen: boolean; onPress: () => void }): ReactNode {
  const palette = useKitPalette();
  return (
    <Pressable accessibilityRole="radio" accessibilityState={{ selected: chosen }} onPress={onPress}>
      <Row align="center" gap={12} padding={12} radius={12} background={chosen ? selectedColor(palette) : undefined}>
        <Icon name={icon} size={ICON_SIZE.md} color={chosen ? palette.link : palette.sub} />
        <Column weight={1} minWidth={0}>
          <Text size="md">{title}</Text>
          <Text size="xs" color="secondary">{line}</Text>
        </Column>
        {chosen ? <Icon name="check" size={ICON_SIZE.md} color={palette.link} /> : null}
      </Row>
    </Pressable>
  );
}

function ShareModal({ chat, open, onClose }: { chat: Chat; open: boolean; onClose: () => void }): ReactNode {
  const client = useQueryClient();
  const [shared, setShared] = useState<ChatShared>(chat.shared);
  const [picked, setPicked] = useState(() => new Set(chat.members));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toggle = (id: string): void => {
    setPicked((now) => togglePicked(now, id));
  };
  const save = (): void => {
    setBusy(true);
    setError(null);
    changeChat(chat.id, { shared, members: [...picked] })
      .then(async (saved) => {
        await putChat(client, saved);
        refreshChat(client, chat.id).catch(logError('chat refresh'));
        onClose();
      })
      .catch((err: unknown) => { setError(queryError(err, 'The sharing was not saved.')); })
      .finally(() => { setBusy(false); });
  };
  return (
    <Modal title="Share this chat" open={open} onClose={() => { if (!busy) onClose(); }}>
      <Column gap={16}>
        <ModalText>{SHARE_TEXT}</ModalText>
        <Column gap={4}>
          <Choice icon="lock" title="Only you and the people you add" line="Nobody else in the organization sees it." chosen={shared === 'private'} onPress={() => { setShared('private'); }} />
          <Choice icon="officeBuilding" title="Everyone in the organization" line="Every member can find it in their chats." chosen={shared === 'organization'} onPress={() => { setShared('organization'); }} />
        </Column>
        {shared === 'private' ? <PeoplePicker owner={chat.createdBy} picked={picked} toggle={toggle} /> : null}
        <Actions error={error} cancel={{ onPress: onClose, disabled: busy }} main={{ label: 'Save', busy, onPress: save }} />
      </Column>
    </Modal>
  );
}

type Open = 'rename' | 'share' | null;

export function ChatMenu({ chat }: { chat: Chat }): ReactNode {
  const client = useQueryClient();
  const [open, setOpen] = useState<Open>(null);
  const pin = (): void => {
    pinChat(chat.id, !chat.pinned)
      .then(() => putChat(client, { ...chat, pinned: !chat.pinned }))
      .catch(logError('chat pin'));
  };
  const rename = async (title: string): Promise<void> => {
    await putChat(client, await changeChat(chat.id, { title }));
  };
  const items: MenuItem[] = [
    { label: chat.pinned ? 'Unpin' : 'Pin', icon: 'pin', onSelect: pin },
    ...(chat.manage ? [{ label: 'Rename', icon: 'pencil' as const, onSelect: () => { setOpen('rename'); } }, { label: 'Share', icon: 'users' as const, onSelect: () => { setOpen('share'); } }] : []),
  ];
  const menu = chat.manage ? (
    <DeleteMenu
      label="Chat menu"
      items={items}
      item="Delete chat"
      title="Delete this chat?"
      lines={['Every message in it is deleted for everyone who can open it.']}
      action="Delete"
      failure="The chat was not deleted."
      run={() => deleteChat(chat.id)}
      onDone={() => {
        go({ kind: 'chat-home' });
        dropChat(client, chat.id).catch(logError('chat delete'));
      }}
    />
  ) : (
    <KebabMenu label="Chat menu" items={items} />
  );
  return (
    <>
      {menu}
      {open === 'rename' ? <NameModal title="Rename this chat" action="Rename" placeholder="Chat title" field="Title" initial={chat.title} failure="The chat was not renamed." open onClose={() => { setOpen(null); }} onSubmit={rename} /> : null}
      {open === 'share' ? <ShareModal chat={chat} open onClose={() => { setOpen(null); }} /> : null}
    </>
  );
}
