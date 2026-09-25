import { type ReactNode, useEffect, useState } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitPalette, useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Text, Button } from './ui.js';
import { MetroLogo } from './MetroLogo.js';
import { EmailLogin } from './EmailLogin.js';
import { GoogleMark } from './GoogleMark.js';
import { GitHubMark } from './GitHubMark.js';
import { daemonHost, routedDaemon } from '../auth/daemon.js';
import { atWaitlist, clearOutcome, readOutcome } from '../auth/login-route.js';
import { pendingInvitation } from '../auth/invitation.js';
import { loginUrl, PROVIDERS, type Intent, type Provider } from '../api/auth.js';

const CONTENT_WIDTH = 340;
const CARD_PAD = 24;
const CARD_WIDTH = CONTENT_WIDTH + 2 * CARD_PAD;
const CARD_GAP = 32;
const BUTTONS_TOP = 8;
const OR_GAP = 16;
const TITLE_GAP = 14;
const LOGO_GAP = 24;
const PROVIDER_LABEL: Record<Provider, string> = { google: 'Continue with Google', microsoft: 'Continue with Microsoft', github: 'Continue with GitHub' };
const ICON_GAP_EXTRA = 4;
const PROVIDER_ICON: Record<Provider, number> = { google: 22, microsoft: 20, github: 22 };
const FULL_WIDTH = { alignSelf: 'stretch' } as const;
const ABOUT = 'Your agents, on your machines, in every chat you use. Your keys stay yours.';
const CENTER_TEXT = { textAlign: 'center' } as const;
const WAITLIST_TITLE = 'Join the waitlist';
const JOINED = 'You are on the waitlist. We will let you in soon, and you can then log in with the same account.';
const INVITED = 'Your invitation is accepted. Log in with the same account to open Metro.';
const INVITATION = 'You are invited to an organization. Log in with the address the invitation was sent to: Google, Microsoft, GitHub or a code by email.';
const COPYRIGHT = `© ${String(new Date().getFullYear())} Metro`;

const REFUSALS: Record<string, string> = {
  'no-account': 'No Metro account for this email yet. Join the waitlist first.',
  waiting: 'You are on the waitlist already. We will let you in soon.',
  'not-open': 'Metro is not open to this account.',
  unverified: 'That account has no verified email address, so Metro cannot accept it. Log in with a code sent to your email instead.',
  cancelled: 'The sign-in was cancelled.',
  failed: 'The sign-in failed. Try again.',
};

function refusalText(refused: string | null): string | null {
  if (refused === null) return null;
  return REFUSALS[refused] ?? REFUSALS.failed ?? null;
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

function ProviderButtons({ intent }: { intent: Intent }): ReactNode {
  const dark = useKitScheme() === 'dark';
  const onButton = useKitPalette().bg;
  return (
    <Col gap={10}>
      {PROVIDERS.map((provider) => (
        <Button
          key={provider}
          size="lg"
          color="primary"
          dark={dark}
          label={PROVIDER_LABEL[provider]}
          icon={providerMark(provider, onButton)}
          style={FULL_WIDTH}
          onPress={() => {
            window.location.assign(loginUrl(provider, intent));
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

const TOP_LOGO = 24;

function TopBar(): ReactNode {
  const palette = useKitPalette();
  return (
    <div className="login-top">
      <a className="login-logo" href="#/" aria-label="Metro home">
        <MetroLogo size={TOP_LOGO} color={palette.link} />
      </a>
    </div>
  );
}

function Frame({ title, children }: { title: ReactNode; children: ReactNode }): ReactNode {
  return (
    <div className="login-page">
      <TopBar />
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
  const [outcome] = useState(readOutcome);
  useEffect(clearOutcome, []);
  const failed = refusalText(outcome.refused);
  const waitlist = atWaitlist();
  if (waitlist && outcome.joined)
    return (
      <Frame title={WAITLIST_TITLE}>
        <Text size="md" style={CENTER_TEXT}>
          {JOINED}
        </Text>
      </Frame>
    );
  return (
    <Frame title={waitlist ? WAITLIST_TITLE : 'Log in'}>
      <DaemonHint />
      {failed === null ? null : (
        <Text size="xl" role="danger" style={CENTER_TEXT}>
          {failed}
        </Text>
      )}
      {pendingInvitation() !== null && !outcome.invited ? (
        <Text size="xl" style={CENTER_TEXT}>
          {INVITATION}
        </Text>
      ) : null}
      {outcome.invited ? (
        <Text size="xl" style={CENTER_TEXT}>
          {INVITED}
        </Text>
      ) : null}
      <Col padding={{ top: BUTTONS_TOP }} gap={OR_GAP}>
        <ProviderButtons intent={waitlist ? 'waitlist' : 'login'} />
        <Text size="sm" role="secondary" style={CENTER_TEXT}>
          or with a code sent to your work email
        </Text>
        <EmailLogin intent={waitlist ? 'waitlist' : 'login'} />
      </Col>
    </Frame>
  );
}
