import { type ReactNode } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Text, Button } from './ui';

interface TopBarProps {
  email: string;
  expiresAt: number;
  onStart: () => void;
  onLock: () => void;
}

function expiryLabel(expiresAt: number): string {
  return new Date(expiresAt).toLocaleDateString(undefined, { dateStyle: 'medium' });
}

export function TopBar({ email, expiresAt, onStart, onLock }: TopBarProps): ReactNode {
  const dark = useKitScheme() === 'dark';
  return (
    <Row justify="between" align="center" gap={12} wrap>
      <Col gap={2} style={{ flexShrink: 1, minWidth: 0 }}>
        <Text size="4xl" weight="semibold">Metro</Text>
        <Text size="sm" role="secondary">
          {email} · session expires {expiryLabel(expiresAt)}
        </Text>
      </Col>
      <Row gap={8} align="center">
        <Button color="secondary" dark={dark} onPress={onStart} label="Claude Code" />
        <Button color="secondary" dark={dark} onPress={onLock} label="Log out" />
      </Row>
    </Row>
  );
}
