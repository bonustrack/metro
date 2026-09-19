import { type ReactNode, useEffect, useState } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitPalette, useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Text, Button } from './ui.js';
import { BootLoading } from './BootLoading.js';
import { LOGO_ASPECT, MetroLogo } from './MetroLogo.js';
import { GoogleMark } from './GoogleMark.js';
import { GitHubMark } from './GitHubMark.js';
import { daemonHost, routedDaemon } from '../auth/daemon.js';
import { atSignup } from '../auth/login-route.js';
import { fetchAuthStatus, loginUrl, type Provider } from '../api/auth.js';

const CONTENT_WIDTH = 340;
const CARD_PAD = 24;
const CARD_WIDTH = CONTENT_WIDTH + 2 * CARD_PAD;
const CARD_GAP = 32;
const BUTTONS_TOP = 8;
const TITLE_GAP = 14;
const LOGO_GAP = 24;
const PROVIDER_LABEL: Record<Provider, string> = { google: 'Continue with Google', microsoft: 'Continue with Microsoft', github: 'Continue with GitHub' };
const ICON_GAP_EXTRA = 4;
const PROVIDER_ICON: Record<Provider, number> = { google: 22, microsoft: 20, github: 22 };
const FULL_WIDTH = { alignSelf: 'stretch' } as const;
const ABOUT = 'Your agents, on your machines, in every chat you use. Your keys stay yours.';
const CENTER_TEXT = { textAlign: 'center' } as const;
const LOGO_WIDTH = 64;
const LOGO_SIZE = Math.round(LOGO_WIDTH / LOGO_ASPECT);
const SIGNUP_HASH = '#/signup';
const LOGIN_HASH = '#/login';
const COPYRIGHT = `© ${String(new Date().getFullYear())} Metro`;
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

function providerMark(provider: Provider, onButton: string): ReactNode {
  const mark =
    provider === 'google' ? (
      <GoogleMark size={PROVIDER_ICON.google} />
    ) : provider === 'github' ? (
      <GitHubMark size={PROVIDER_ICON.github} color={onButton} />
    ) : (
      <img src="/microsoft.png" alt="" width={PROVIDER_ICON.microsoft} height={PROVIDER_ICON.microsoft} />
    );
  return <Row padding={{ right: ICON_GAP_EXTRA }}>{mark}</Row>;
}

function ProviderButtons({ offer }: { offer: Offer }): ReactNode {
  const dark = useKitScheme() === 'dark';
  const onButton = useKitPalette().bg;
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
          icon={providerMark(provider, onButton)}
          style={FULL_WIDTH}
          onPress={() => {
            window.location.assign(loginUrl(provider));
          }}
        />
      ))}
    </Col>
  );
}

function Footer(): ReactNode {
  return (
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
  );
}

function Frame({ title, children }: { title: ReactNode; children: ReactNode }): ReactNode {
  return (
    <div className="login-page">
      <Row justify="center" align="start" padding={{ x: 24, bottom: 24 }}>
        <Col gap={CARD_GAP} width="100%" maxWidth={CARD_WIDTH} padding={CARD_PAD}>
          <Col gap={typeof title === 'string' ? TITLE_GAP : LOGO_GAP}>
            <Row justify="center">
              {typeof title === 'string' ? (
                <Text size="6xl" weight="medium">
                  {title}
                </Text>
              ) : (
                title
              )}
            </Row>
            <Text size="xl" style={CENTER_TEXT}>
              {ABOUT}
            </Text>
          </Col>
          {children}
          <Footer />
        </Col>
      </Row>
    </div>
  );
}

function DaemonHint(): ReactNode {
  const heading = routedDaemon();
  if (heading === null) return null;
  return (
    <Row justify="center">
      <Text size="sm" role="secondary">
        then on to {daemonHost(heading)}
      </Text>
    </Row>
  );
}

export function Login(): ReactNode {
  const offer = useProviders();
  const failed = loginError();
  if (offer === null) return <BootLoading />;
  return (
    <Frame title={atSignup() ? 'Sign up' : 'Log in'}>
      <DaemonHint />
      {failed === null ? null : (
        <Text size="sm" role="danger">
          {failed}
        </Text>
      )}
      <Col padding={{ top: BUTTONS_TOP }}>
        <ProviderButtons offer={offer} />
      </Col>
    </Frame>
  );
}

export function Landing(): ReactNode {
  const dark = useKitScheme() === 'dark';
  const palette = useKitPalette();
  return (
    <Frame title={<MetroLogo size={LOGO_SIZE} color={palette.link} />}>
      <Col gap={10} padding={{ top: BUTTONS_TOP }}>
        <Button
          size="lg"
          color="primary"
          dark={dark}
          label="Sign up"
          style={FULL_WIDTH}
          onPress={() => {
            window.location.hash = SIGNUP_HASH;
          }}
        />
        <Button
          size="lg"
          color="secondary"
          dark={dark}
          label="Log in"
          style={FULL_WIDTH}
          onPress={() => {
            window.location.hash = LOGIN_HASH;
          }}
        />
      </Col>
    </Frame>
  );
}
