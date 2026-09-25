import type { ReactNode } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitPalette, useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Button, Text } from './ui.js';
import { ChatIcon } from './ChatIcon.js';
import { SHRINK } from '../theme.js';
import { chatLink } from '../api/senders.js';

const CHAT_ICON = 18;

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

function ApproveButton({ approves, busy, onApprove }: { approves: boolean | null; busy: boolean; onApprove: (approves: boolean) => void }): ReactNode {
  const dark = useKitScheme() === 'dark';
  if (approves === null) return null;
  return (
    <Button
      size="sm"
      color={approves ? 'primary' : 'secondary'}
      dark={dark}
      disabled={busy}
      label={approves ? 'Can approve' : 'Cannot approve'}
      onPress={() => {
        onApprove(!approves);
      }}
    />
  );
}

export function SenderRow({ station, id, name, handle, busy, approves, onApprove, onRemove }: SenderRowProps): ReactNode {
  const palette = useKitPalette();
  const dark = useKitScheme() === 'dark';
  const title = name === '' ? (handle === '' ? id : handle) : name;
  const subtitle = subtitleOf(id, name, handle === title ? '' : handle);
  const link = chatLink(station, id, handle === '' ? undefined : handle);
  return (
    <Row justify="between" align="center" gap={12} padding={{ y: 10 }} border={{ bottom: { width: 1, color: palette.border } }}>
      <Col gap={2} style={SHRINK}>
        <Text size="sm" numberOfLines={1}>{title}</Text>
        {subtitle === '' ? null : <Text size="sm" role="secondary" numberOfLines={1}>{subtitle}</Text>}
      </Col>
      <Row gap={8} align="center">
        {link === null ? null : (
          <a className="kebab" href={link} target="_blank" rel="noreferrer" aria-label={`Open a chat with ${title}`} title="Open chat">
            <ChatIcon size={CHAT_ICON} color={palette.link} />
          </a>
        )}
        <ApproveButton approves={approves} busy={busy} onApprove={onApprove} />
        <Button size="sm" color="secondary" dark={dark} disabled={busy} label="Remove" onPress={onRemove} />
      </Row>
    </Row>
  );
}
