import { type ReactNode, useState } from 'react';
import { Button, Card, Col, Input, Row, Text } from '@metro-labs/kit';

interface LoginProps {
  onSubmit: (apiKey: string) => void;
  busy: boolean;
  error: string | null;
}

export function Login({ onSubmit, busy, error }: LoginProps): ReactNode {
  const [apiKey, setApiKey] = useState('');
  const submit = (): void => {
    const trimmed = apiKey.trim();
    if (trimmed.length > 0 && !busy) onSubmit(trimmed);
  };
  return (
    <Row justify="center" align="center" style={{ minHeight: '100%', padding: 24 }}>
      <Card padding={28} style={{ width: '100%', maxWidth: 420 }}>
        <form
          onSubmit={(e) => { e.preventDefault(); submit(); }}
        >
          <Col gap={18}>
            <Col gap={6}>
              <Text as="p" size="5xl" weight="semibold" role="head">Metro</Text>
              <Text as="p" role="sub">Enter your API key to view its accounts.</Text>
            </Col>
            <Col gap={8}>
              <Text as="p" size="sm" role="sub">API key</Text>
              <Input
                value={apiKey}
                onChange={setApiKey}
                type="password"
                placeholder="metro API key"
                ariaLabel="Metro API key"
                autoFocus
              />
            </Col>
            {error !== null && (
              <Text as="p" size="sm" role="danger">{error}</Text>
            )}
            <Button type="submit" variant="primary" disabled={busy || apiKey.trim().length === 0}>
              {busy ? 'Unlocking…' : 'Unlock'}
            </Button>
          </Col>
        </form>
      </Card>
    </Row>
  );
}
