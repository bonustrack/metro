import { type ReactNode } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { Text } from '@stage-labs/kit/react-native/text';
import { Button } from '@stage-labs/kit/react-native/button';
import { Card } from '@stage-labs/kit/react-native/card';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { startLoginUrl } from '../auth/session';

interface LoginProps {
  error: string | null;
}

export function Login({ error }: LoginProps): ReactNode {
  const dark = useKitScheme() === 'dark';
  const signIn = (): void => {
    window.location.assign(startLoginUrl());
  };
  return (
    <Row justify="center" align="center" style={{ minHeight: '100%', padding: 24 }}>
      <Card dark={dark} padding={28} style={{ width: '100%', maxWidth: 420 }}>
        <Col gap={18}>
          <Col gap={6}>
            <Text size="5xl" weight="semibold">Metro</Text>
            <Text role="secondary">
              Sign in with Google to create an agent and get its MCP endpoint.
            </Text>
          </Col>
          <Button color="primary" dark={dark} onPress={signIn} label="Continue with Google" />
          {error !== null ? <Text size="sm" role="danger">{error}</Text> : null}
        </Col>
      </Card>
    </Row>
  );
}
