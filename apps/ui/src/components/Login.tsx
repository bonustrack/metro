import { type ReactNode } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitPalette, useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { BLOCK_RADIUS_DEFAULT } from '@stage-labs/kit/tokens';
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
  const palette = useKitPalette();
  const side = { width: 1, color: palette.border };
  const signIn = (): void => {
    window.location.assign(startLoginUrl());
  };
  return (
    <Row justify="center" align="center" flex={1} padding={24}>
      <Col
        gap={28}
        width="100%"
        maxWidth={340}
        padding={24}
        radius={BLOCK_RADIUS_DEFAULT}
        border={{ top: side, right: side, bottom: side, left: side }}
      >
          <Row justify="center">
            <MetroLogo size={48} color={palette.link} />
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
