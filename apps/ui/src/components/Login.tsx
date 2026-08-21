import { type ReactNode } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Text, Button } from './ui';
import { GoogleLogo } from './GoogleLogo';
import { MetroLogo } from './MetroLogo';
import { PageTitle } from './PageTitle';
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
    <Row justify="center" align="center" flex={1} padding={24}>
      <Col gap={18} width="100%" maxWidth={420}>
          <Row justify="center">
            <MetroLogo size={48} color={dark ? '#ffffff' : '#000000'} />
          </Row>
          <Row justify="center">
            <PageTitle>Log in</PageTitle>
          </Row>
          <Button
            block
            color="primary"
            dark={dark}
            onPress={signIn}
            iconStart={<GoogleLogo />}
            label="Continue with Google"
          />
          {error !== null ? <Text size="sm" role="danger">{error}</Text> : null}
      </Col>
    </Row>
  );
}
