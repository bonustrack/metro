import type { ReactNode } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { Text } from './ui.js';
import { ChatIcon } from './ChatIcon.js';
import { KebabMenu } from './KebabMenu.js';
import { type MenuItem } from './Dropdown.js';
import { SHRINK } from '../theme.js';
import { chatLink } from '../api/senders.js';

const CHAT_ICON = 16;

export interface SenderRowProps {
  station: string;
  id: string;
  name: string;
  handle: string;
  busy: boolean;
  approves: boolean | null;
  onApprove: (approves: boolean) => void;
  onRemove: () => void;
}

const subtitleOf = (id: string, name: string, handle: string): string =>
  [handle, name === '' ? '' : id].filter((part) => part !== '' && part !== name).join(' · ');

export function SenderRow({ station, id, name, handle, busy, approves, onApprove, onRemove }: SenderRowProps): ReactNode {
  const palette = useKitPalette();
  const title = name === '' ? (handle === '' ? id : handle) : name;
  const subtitle = subtitleOf(id, name, handle === title ? '' : handle);
  const link = chatLink(station, id, handle === '' ? undefined : handle);
  const items: MenuItem[] = [
    ...(approves === null
      ? []
      : [
          {
            label: approves ? 'Stop approving' : 'Can approve requests',
            icon: 'shieldCheck' as const,
            onSelect: () => {
              if (!busy) onApprove(!approves);
            },
          },
        ]),
    {
      label: 'Remove',
      danger: true,
      onSelect: () => {
        if (!busy) onRemove();
      },
    },
  ];
  return (
    <Row justify="between" align="center" gap={12} padding={{ x: 16, y: 10 }}>
      <Col gap={2} style={SHRINK}>
        <Row gap={8} align="center">
          <Text size="md" weight="medium" numberOfLines={1} style={SHRINK}>
            {title}
          </Text>
          {approves === true ? <span className="tag">Approver</span> : null}
        </Row>
        {subtitle === '' ? null : (
          <Text size="sm" role="secondary" numberOfLines={1}>
            {subtitle}
          </Text>
        )}
      </Col>
      <Row gap={8} align="center">
        {link === null ? null : (
          <a className="kebab" href={link} target="_blank" rel="noreferrer" aria-label={`Open a chat with ${title}`} title="Open chat">
            <ChatIcon size={CHAT_ICON} color={palette.link} />
          </a>
        )}
        <KebabMenu items={items} label={`Actions for ${title}`} />
      </Row>
    </Row>
  );
}
