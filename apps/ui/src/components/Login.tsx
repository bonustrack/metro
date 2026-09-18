import { type ReactNode, useEffect, useState } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Text, Button } from './ui.js';
import { BootLoading } from './BootLoading.js';
import { ConnectorFavicon } from './ConnectorFavicon.js';
import { GoogleMark } from './GoogleMark.js';
import { daemonHost, routedDaemon } from '../auth/daemon.js';
import { fetchAuthStatus, loginUrl, type Provider } from '../api/auth.js';

const CONTENT_WIDTH = 340;
const CARD_PAD = 24;
const CARD_WIDTH = CONTENT_WIDTH + 2 * CARD_PAD;
const CARD_GAP = 32;
const BUTTONS_TOP = 8;
const TITLE_GAP = 14;
const PROVIDER_LABEL: Record<Provider, string> = { google: 'Continue with Google', microsoft: 'Continue with Microsoft', github: 'Continue with GitHub' };
const PROVIDER_SITE: Record<Provider, string> = { google: 'https://google.com', microsoft: 'https://microsoft.com', github: 'https://github.com' };
const ICON_GAP_EXTRA = 4;
const PROVIDER_ICON: Record<Provider, number> = { google: 22, microsoft: 20, github: 22 };
const FULL_WIDTH = { alignSelf: 'stretch' } as const;
const ABOUT = 'Your agents, on your machines, in every chat you use. Your keys stay yours.';
const CENTER_TEXT = { textAlign: 'center' } as const;
const COPYRIGHT = `© ${String(new Date().getFullYear())} Metro Labs`;
const OFF = 'Log-in is not set up on this Metro yet.';
const AWAY = 'Log-in is not available right now. Try again in a minute.';

function loginError(): string | null {
  const raw = window.location.hash.replace(/^#/, '');
  const cut = raw.indexOf('?');
  if (cut === -1) return null;
  const error = new URLSearchParams(raw.slice(cut + 1)).get('error');
  return error === null || error === '' ? null : error;
}

type Offer = { providers: Provider[] } | { note: string };

function useProviders(): Offer | null {
  const [offer, setOffer] = useState<Offer | null>(null);
  useEffect(() => {
    fetchAuthStatus()
      .then((status) => {
        if (!status.enabled) setOffer({ note: OFF });
        else setOffer(status.providers.length === 0 ? { note: AWAY } : { providers: status.providers });
      })
      .catch(() => {
        setOffer({ note: AWAY });
      });
  }, []);
  return offer;
}

function providerMark(provider: Provider): ReactNode {
  const mark = provider === 'google' ? <GoogleMark size={PROVIDER_ICON.google} /> : <ConnectorFavicon name={provider} url={PROVIDER_SITE[provider]} size={PROVIDER_ICON[provider]} radius={0} />;
  return <Row padding={{ right: ICON_GAP_EXTRA }}>{mark}</Row>;
}

function ProviderButtons({ offer }: { offer: Offer }): ReactNode {
  const dark = useKitScheme() === 'dark';
  if ('note' in offer)
    return (
      <Row justify="center">
        <Text size="sm" role="secondary">
          {offer.note}
        </Text>
      </Row>
    );
  const { providers } = offer;
  return (
    <Col gap={10}>
      {providers.map((provider) => (
        <Button
          key={provider}
          size="lg"
          color="primary"
          dark={dark}
          label={PROVIDER_LABEL[provider]}
          icon={providerMark(provider)}
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
  const offer = useProviders();
  const failed = loginError();
  if (offer === null) return <BootLoading />;
  return (
    <div className="login-page">
      <Row justify="center" align="start" padding={{ x: 24, bottom: 24 }}>
        <Col gap={CARD_GAP} width="100%" maxWidth={CARD_WIDTH} padding={CARD_PAD}>
        <Col gap={TITLE_GAP}>
          <Row justify="center">
            <Text size="6xl" weight="medium">
              Log in
            </Text>
          </Row>
          <Text size="xl" style={CENTER_TEXT}>
            {ABOUT}
          </Text>
        </Col>
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
          <Col padding={{ top: BUTTONS_TOP }}>
            <ProviderButtons offer={offer} />
          </Col>
          <Row justify="center" gap={16}>
            <Text size="sm" role="secondary">
              {COPYRIGHT}
            </Text>
            <Text size="sm" role="secondary">
              Terms
            </Text>
            <Text size="sm" role="secondary">
              Privacy
            </Text>
          </Row>
        </Col>
      </Row>
    </div>
  );
}
