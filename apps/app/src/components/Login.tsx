import { type ReactNode, useEffect, useState } from 'react';
import { Image, Platform, StyleSheet, View } from 'react-native';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitPalette, useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Button } from '@stage-labs/kit/react-native/button';
import { Text } from '@stage-labs/kit/react-native/text';
import { daemonHost, routedDaemon } from '@metro-labs/client/auth/daemon';
import { atWaitlist, clearOutcome, readOutcome } from '@metro-labs/client/auth/login-route';
import { pendingInvitation } from '@metro-labs/client/auth/invitation';
import { loginUrl, PROVIDERS, type Intent, type Provider } from '@metro-labs/client/api/auth';
import microsoft from '../../assets/microsoft.png';
import { MetroLogo } from './MetroLogo.js';
import { LegalLinks } from './LegalLinks.js';
import { EmailLogin } from './EmailLogin.js';
import { GoogleMark } from './GoogleMark.js';
import { GitHubMark } from './GitHubMark.js';
import { RouteLink } from './RouteLink.js';
import { PageScroll } from './PageScroll.js';
import { goExternal } from '../lib/open.js';
import { appLogin } from '../lib/app-login.js';
import { CENTER_TEXT, FULL_WIDTH, webOnly } from '../lib/style.js';

const CONTENT_WIDTH = 340;
const CARD_PAD = 24;
const CARD_WIDTH = CONTENT_WIDTH + 2 * CARD_PAD;
const PROVIDER_LABEL: Record<Provider, string> = { google: 'Continue with Google', microsoft: 'Continue with Microsoft', github: 'Continue with GitHub' };
const PROVIDER_ICON: Record<Provider, number> = { google: 22, microsoft: 20, github: 22 };
const ABOUT = 'Your agents, on your machines, in every chat you use. Your keys stay yours.';
const WAITLIST_TITLE = 'Join the waitlist';
const JOINED = 'You are on the waitlist. We will let you in soon, and you can then log in with the same account.';
const INVITED = 'Your invitation is accepted. Log in with the same account to open Metro.';
const INVITATION = 'You are invited to an organization. Log in with the address the invitation was sent to: Google, Microsoft, GitHub or a code by email.';
const COPYRIGHT = `© ${String(new Date().getFullYear())} Metro`;
const TOP_LOGO = 24;
const WEB = Platform.OS === 'web';

const REFUSALS: Record<string, string> = {
  'no-account': 'No Metro account for this email yet. Join the waitlist first.',
  waiting: 'You are on the waitlist already. We will let you in soon.',
  'not-open': 'Metro is not open to this account.',
  unverified: 'That account has no verified email address, so Metro cannot accept it. Log in with a code sent to your email instead.',
  cancelled: 'The sign-in was cancelled.',
  failed: 'The sign-in failed. Try again.',
};

const styles = StyleSheet.create({
  microsoft: { width: PROVIDER_ICON.microsoft, height: PROVIDER_ICON.microsoft },
  top: { position: 'absolute', top: 24, left: 24, zIndex: 10 },
});

const TOP = webOnly({ position: 'fixed' });

function refusalText(refused: string | null): string | null {
  if (refused === null) return null;
  return REFUSALS[refused] ?? REFUSALS.failed ?? null;
}

function providerMark(provider: Provider, onButton: string): ReactNode {
  const mark =
    provider === 'google' ? <GoogleMark size={PROVIDER_ICON.google} /> : provider === 'github' ? <GitHubMark size={PROVIDER_ICON.github} color={onButton} /> : <Image source={microsoft} style={styles.microsoft} />;
  return <Row padding={{ right: 4 }}>{mark}</Row>;
}

function ProviderButtons({ intent }: { intent: Intent }): ReactNode {
  const dark = useKitScheme() === 'dark';
  const onButton = useKitPalette().text;
  const [failed, setFailed] = useState<string | null>(null);
  return (
    <Col gap={10}>
      {PROVIDERS.map((provider) => (
        <Button
          key={provider}
          size="lg"
          color="secondary"
          variant="outline"
          dark={dark}
          label={PROVIDER_LABEL[provider]}
          icon={providerMark(provider, onButton)}
          style={FULL_WIDTH}
          onPress={() => {
            if (WEB) goExternal(loginUrl(provider, intent));
            else {
              setFailed(null);
              appLogin(provider, intent).catch((err: unknown) => {
                setFailed(err instanceof Error ? err.message : 'The sign-in failed. Try again.');
              });
            }
          }}
        />
      ))}
      {failed === null ? null : (
        <Text size="xs" role="danger" style={CENTER_TEXT}>
          {failed}
        </Text>
      )}
    </Col>
  );
}

function Footer(): ReactNode {
  return (
    <Row justify="center" gap={16}>
      <Text size="2xs" role="secondary">
        {COPYRIGHT}
      </Text>
      <LegalLinks newTab />
    </Row>
  );
}

function TopLogo(): ReactNode {
  const palette = useKitPalette();
  if (!WEB) return null;
  return (
    <View style={[styles.top, TOP]}>
      <RouteLink to="#/" label="Metro home">
        <MetroLogo size={TOP_LOGO} color={palette.link} />
      </RouteLink>
    </View>
  );
}

function Frame({ title, children }: { title: string; children: ReactNode }): ReactNode {
  return (
    <PageScroll>
      <TopLogo />
      <Row justify="center" align="start" padding={{ x: 24, top: WEB ? '15vh' : 64, bottom: 24 }}>
        <Col gap={32} width="100%" maxWidth={CARD_WIDTH} padding={CARD_PAD}>
          <Col gap={14}>
            <Row justify="center">
              <Text size="3xl" weight="medium">
                {title}
              </Text>
            </Row>
            <Text size="md" style={CENTER_TEXT}>
              {ABOUT}
            </Text>
          </Col>
          {children}
          <Footer />
        </Col>
      </Row>
    </PageScroll>
  );
}

function DaemonHint(): ReactNode {
  const heading = routedDaemon();
  if (heading === null) return null;
  return (
    <Row justify="center">
      <Text size="2xs" role="secondary">
        then on to {daemonHost(heading)}
      </Text>
    </Row>
  );
}

function Notes({ failed, invited }: { failed: string | null; invited: boolean }): ReactNode {
  return (
    <>
      <DaemonHint />
      {failed === null ? null : (
        <Text size="md" role="danger" style={CENTER_TEXT}>
          {failed}
        </Text>
      )}
      {pendingInvitation() !== null && !invited ? (
        <Text size="md" style={CENTER_TEXT}>
          {INVITATION}
        </Text>
      ) : null}
      {invited ? (
        <Text size="md" style={CENTER_TEXT}>
          {INVITED}
        </Text>
      ) : null}
    </>
  );
}

export function Login(): ReactNode {
  const [outcome] = useState(readOutcome);
  useEffect(clearOutcome, []);
  const waitlist = atWaitlist();
  const intent: Intent = waitlist ? 'waitlist' : 'login';
  if (waitlist && outcome.joined)
    return (
      <Frame title={WAITLIST_TITLE}>
        <Text size="xs" style={CENTER_TEXT}>
          {JOINED}
        </Text>
      </Frame>
    );
  return (
    <Frame title={waitlist ? WAITLIST_TITLE : 'Log in'}>
      <Notes failed={refusalText(outcome.refused)} invited={outcome.invited} />
      <Col padding={{ top: 8 }} gap={16}>
        <EmailLogin intent={intent} />
        <Text size="2xs" role="secondary" style={CENTER_TEXT}>
          or
        </Text>
        <ProviderButtons intent={intent} />
      </Col>
    </Frame>
  );
}
