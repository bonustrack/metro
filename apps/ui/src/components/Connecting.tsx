import { type ReactNode } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { Text } from '@stage-labs/kit/react-native/text';
import { Button } from '@stage-labs/kit/react-native/button';
import { Card } from '@stage-labs/kit/react-native/card';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';

function mask(apiKey: string): string {
  if (apiKey.length <= 4) return '•'.repeat(apiKey.length);
  return '•'.repeat(Math.min(apiKey.length - 4, 16)) + apiKey.slice(-4);
}

interface ConnectingProps {
  apiKey: string;
  onCancel: () => void;
}

export function Connecting({ apiKey, onCancel }: ConnectingProps): ReactNode {
  const dark = useKitScheme() === 'dark';
  return (
    <Row justify="center" align="center" style={{ minHeight: '100%', padding: 24 }}>
      <Card dark={dark} padding={28} style={{ width: '100%', maxWidth: 420 }}>
        <Col gap={18}>
          <Col gap={6}>
            <Text size="5xl" weight="semibold">Metro</Text>
            <Text role="secondary">Reconnecting with your saved API key.</Text>
          </Col>
          <Col gap={8}>
            <Text size="sm" role="secondary">API key</Text>
            <Text size="sm" variant="mono">{mask(apiKey)}</Text>
          </Col>
          <Button color="primary" onPress={onCancel} disabled loading label="Connecting" />
          <Button color="secondary" onPress={onCancel} label="Use a different key" />
        </Col>
      </Card>
    </Row>
  );
}
