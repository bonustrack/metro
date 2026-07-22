import { type ReactNode, useState } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { Text } from '@stage-labs/kit/react-native/text';
import { Button } from '@stage-labs/kit/react-native/button';
import { Input } from '@stage-labs/kit/react-native/input';
import { Card } from '@stage-labs/kit/react-native/card';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';

interface LoginProps {
  onSubmit: (apiKey: string) => void;
  busy: boolean;
  error: string | null;
}

export function Login({ onSubmit, busy, error }: LoginProps): ReactNode {
  const [apiKey, setApiKey] = useState('');
  const dark = useKitScheme() === 'dark';
  const trimmed = apiKey.trim();
  const submit = (): void => {
    if (trimmed.length > 0 && !busy) onSubmit(trimmed);
  };
  return (
    <Row justify="center" align="center" style={{ minHeight: '100%', padding: 24 }}>
      <Card dark={dark} padding={28} style={{ width: '100%', maxWidth: 420 }}>
        <Col gap={18}>
          <Col gap={6}>
            <Text size="5xl" weight="semibold">Metro</Text>
            <Text role="secondary">Enter your API key to view its accounts.</Text>
          </Col>
          <Col gap={8}>
            <Text size="sm" role="secondary">API key</Text>
            <Input
              value={apiKey}
              onChangeText={setApiKey}
              onSubmit={submit}
              inputType="password"
              placeholder="metro API key"
              autoFocus
            />
          </Col>
          {error !== null ? <Text size="sm" role="danger">{error}</Text> : null}
          <Button
            color="primary"
            onPress={submit}
            disabled={busy || trimmed.length === 0}
            loading={busy}
            label="Unlock"
          />
        </Col>
      </Card>
    </Row>
  );
}
