import { type ReactNode, useEffect, useState } from 'react';
import { View, StyleSheet } from 'react-native';
import { QueryClientProvider } from '@tanstack/react-query';
import { handoffCode, activeAccount, loadAccount } from '@metro-labs/client/auth/account';
import { AuthUnavailableError, exchangeHandoff, logoutAccount, refreshAccount } from '@metro-labs/client/api/auth';
import { atLanding, atLogin, atWaitlist, goToLanding, goToLogin, leaveLogin } from '@metro-labs/client/auth/login-route';
import { pendingInvitation, takeInvitationFromUrl } from '@metro-labs/client/auth/invitation';
import { clearInitialSignInReturn, initialSignInReturn } from '../lib/location.js';
import { location } from '@metro-labs/client/platform';
import { type Selection } from '@metro-labs/client/selection';
import { BootLoading } from './BootLoading.js';
import { BuildDot } from './BuildDot.js';
import { Login } from './Login.js';
import { Landing } from './landing/Landing.js';
import { LegalPage } from './legal/LegalPage.js';
import { OrganizationSetup } from './OrganizationSetup.js';
import { SignInReturn } from './SignInReturn.js';
import { UnlockedPage } from './UnlockedPage.js';
import { OrganizationGate } from './gates.js';
import { makeQueryClient } from '../lib/queries.js';
import { noteTitle } from '../lib/title.js';
import { onRelaunch } from '../lib/land.js';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

type Phase = 'loading' | 'login' | 'organization' | 'unlocked';

const styles = StyleSheet.create({ root: { flex: 1 } });

async function boot(): Promise<Phase> {
  const handoff = handoffCode(location().hash());
  if (handoff !== null) {
    location().replace('#/');
    await exchangeHandoff(handoff);
  } else loadAccount();
  if (handoff === null && pendingInvitation() !== null) return 'login';
  const stored = activeAccount();
  if (stored !== null && stored.organization !== null && stored.organizationName === null) {
    await refreshAccount().catch((err: unknown) => { if (!(err instanceof AuthUnavailableError)) throw err; });
  }
  const account = activeAccount();
  if (account === null) return 'login';
  return account.organization === null ? 'organization' : 'unlocked';
}

function loginTitle(): string | null {
  if (atLanding()) return null;
  return atWaitlist() ? 'Waitlist' : 'Log in';
}

function usePhase(): [Phase, (next: Phase) => void] {
  const [phase, setPhase] = useState<Phase>('loading');
  const [generation, setGeneration] = useState(0);
  useEffect(
    () =>
      onRelaunch(() => {
        setGeneration((n) => n + 1);
      }),
    [],
  );
  useEffect(() => {
    setPhase('loading');
    boot()
      .then(setPhase)
      .catch(() => {
        setPhase('login');
      });
  }, [generation]);
  return [phase, setPhase];
}

function MetroApp({ selection }: { selection: Selection }): ReactNode {
  useState(takeInvitationFromUrl);
  const [phase, setPhase] = usePhase();
  const lock = (): void => {
    logoutAccount().catch(() => undefined);
    setPhase('login');
  };
  const signOut = (): void => {
    logoutAccount().catch(() => undefined);
    goToLanding();
    setPhase('login');
  };
  const unlock = (): void => {
    leaveLogin();
    setPhase('unlocked');
  };
  const [client] = useState(() => makeQueryClient(lock));
  useEffect(() => {
    if (phase === 'login') {
      client.clear();
      goToLogin();
      noteTitle(loginTitle());
    } else if (phase === 'unlocked' && atLogin()) leaveLogin();
  }, [phase, client, selection]);
  return (
    <QueryClientProvider client={client}>
      {phase === 'loading' ? <BootLoading /> : null}
      {phase === 'login' ? atLanding() ? <Landing /> : <Login /> : null}
      {phase === 'organization' ? <OrganizationSetup onDone={unlock} onLock={lock} /> : null}
      {phase === 'unlocked' ? (
        <OrganizationGate selection={selection} onLock={signOut}>
          <UnlockedPage selection={selection} onLock={signOut} />
        </OrganizationGate>
      ) : null}
    </QueryClientProvider>
  );
}

export function Root({ selection }: { selection: Selection }): ReactNode {
  const [returned] = useState(initialSignInReturn);
  useEffect(() => {
    if (returned === null) clearInitialSignInReturn();
  }, [returned]);
  const insets = useSafeAreaInsets();
  const legal = selection.kind === 'terms-of-use' || selection.kind === 'privacy-policy';
  return (
    <View style={styles.root}>
      {legal ? <LegalPage kind={selection.kind} /> : returned === null ? <MetroApp selection={selection} /> : <SignInReturn ret={returned} />}
      <BuildDot bottom={insets.bottom} />
    </View>
  );
}
