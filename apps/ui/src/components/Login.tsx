import { type ReactNode, useEffect, useState } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitPalette, useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Text, Button } from './ui.js';
import { MetroLogo } from './MetroLogo.js';
import { BootLoading } from './BootLoading.js';
import { ConnectorFavicon } from './ConnectorFavicon.js';
import { daemonHost, routedDaemon } from '../auth/daemon.js';
import { fetchAuthStatus, loginUrl, type Provider } from '../api/auth.js';

const CONTENT_WIDTH = 340;
const CARD_PAD = 24;
const CARD_WIDTH = CONTENT_WIDTH + 2 * CARD_PAD;
const CARD_GAP = 32;
const PROVIDER_LABEL: Record<Provider, string> = { google: 'Continue with Google', microsoft: 'Continue with Microsoft' };
const PROVIDER_SITE: Record<Provider, string> = { google: 'https://google.com', microsoft: 'https://microsoft.com' };
const PROVIDER_ICON = 24;
const FULL_WIDTH = { alignSelf: 'stretch' } as const;
const OFF = 'Sign-in is not configured on this Metro yet.';

function loginError(): string | null {
  const raw = window.location.hash.replace(/^#/, '');
  const cut = raw.indexOf('?');
  if (cut === -1) return null;
  const error = new URLSearchParams(raw.slice(cut + 1)).get('error');
  return error === null || error === '' ? null : error;
}

function useProviders(): Provider[] | null {
  const [providers, setProviders] = useState<Provider[] | null>(null);
  useEffect(() => {
    fetchAuthStatus()
      .then((status) => {
        setProviders(status.enabled ? status.providers : []);
      })
      .catch(() => {
        setProviders([]);
      });
  }, []);
  return providers;
}

function ProviderButtons({ providers }: { providers: Provider[] }): ReactNode {
  const dark = useKitScheme() === 'dark';
  if (providers.length === 0)
    return (
      <Text size="sm" role="secondary">
        {OFF}
      </Text>
    );
  return (
    <Col gap={10}>
      {providers.map((provider) => (
        <Button
          key={provider}
          size="lg"
          color="primary"
          dark={dark}
          label={PROVIDER_LABEL[provider]}
          icon={<ConnectorFavicon name={provider} url={PROVIDER_SITE[provider]} size={PROVIDER_ICON} />}
          style={FULL_WIDTH}
          onPress={() => {
            window.location.assign(loginUrl(provider));
          }}
        />
      ))}
    </Col>
  );
}

export function Login(): ReactNode {
  const palette = useKitPalette();
  const providers = useProviders();
  const failed = loginError();
  if (providers === null) return <BootLoading />;
  return (
    <Row justify="center" align="center" flex={1} padding={24}>
      <Col gap={CARD_GAP} width="100%" maxWidth={CARD_WIDTH} padding={CARD_PAD}>
        <Row justify="center">
          <MetroLogo size={48} color={palette.link} />
        </Row>
        <Row justify="center">
          <Text size="6xl" weight="medium">
            Log in
          </Text>
        </Row>
        {routedDaemon() === null ? null : (
          <Row justify="center">
            <Text size="sm" role="secondary">
              then on to {daemonHost(routedDaemon() ?? '')}
            </Text>
          </Row>
        )}
        {failed === null ? null : (
          <Text size="sm" role="danger">
            {failed}
          </Text>
        )}
        <ProviderButtons providers={providers} />
      </Col>
    </Row>
  );
}
