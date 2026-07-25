import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { Text } from '@stage-labs/kit/react-native/text';
import { Card } from '@stage-labs/kit/react-native/card';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { googleClientId, renderSignIn } from '../auth/google';

interface LoginProps {
  onCredential: (credential: string) => void;
  error: string | null;
}

export function Login({ onCredential, error }: LoginProps): ReactNode {
  const dark = useKitScheme() === 'dark';
  const buttonRef = useRef<HTMLDivElement>(null);
  const clientId = googleClientId();
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    if (clientId === '' || buttonRef.current === null) return;
    renderSignIn(buttonRef.current, clientId, onCredential).catch(
      (err: unknown) => {
        setLoadError(err instanceof Error ? err.message : 'sign-in unavailable');
      },
    );
  }, [clientId, onCredential]);

  return (
    <Row justify="center" align="center" style={{ minHeight: '100%', padding: 24 }}>
      <Card dark={dark} padding={28} style={{ width: '100%', maxWidth: 420 }}>
        <Col gap={18}>
          <Col gap={6}>
            <Text size="5xl" weight="semibold">Metro</Text>
            <Text role="secondary">Sign in with Google to view your accounts.</Text>
          </Col>
          {clientId === '' ? (
            <Text size="sm" role="danger">
              Google sign-in is not configured. Set VITE_GOOGLE_CLIENT_ID at build time.
            </Text>
          ) : (
            <div ref={buttonRef} style={{ minHeight: 44 }} />
          )}
          {loadError !== null ? (
            <Text size="sm" role="danger">{loadError}</Text>
          ) : null}
          {error !== null ? <Text size="sm" role="danger">{error}</Text> : null}
        </Col>
      </Card>
    </Row>
  );
}
