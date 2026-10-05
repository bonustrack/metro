import { type ReactNode, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { Button } from '@stage-labs/kit/react-native/button';
import { Text } from '@stage-labs/kit/react-native/text';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { daemonBase } from '@metro-labs/client/auth/daemon';
import { beginOpenRouterLogin, cancelOpenRouterLogin, OPENROUTER_LOGIN_SINCE, pollOpenRouterLogin, type OpenRouterLogin } from '@metro-labs/client/api/openrouter-login';
import { olderThan } from '@metro-labs/client/api/version';
import { queryError, useModeQuery } from '../lib/queries.js';
import { useSignInTab } from './sign-in-tab.js';
import { SignInLink } from './ProviderSignIn.js';
import { TextLink } from './TextLink.js';
import { logError } from '../lib/log.js';

function useAttemptCleanup(login: OpenRouterLogin | null): void {
  useEffect(() => {
    if (login === null) return undefined;
    return () => { cancelOpenRouterLogin(login).catch(logError('OpenRouter sign-in cleanup')); };
  }, [login]);
}

function usePolling(login: OpenRouterLogin | null, settle: (error: string | null) => void, onDone: () => void): string | null {
  const client = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setError(null);
    if (login === null) return undefined;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async (): Promise<void> => {
      if (Date.now() >= login.expiresAt) {
        settle('This OpenRouter sign-in expired. Start again.');
        return;
      }
      try {
        const result = await pollOpenRouterLogin(login);
        if (stopped) return;
        setError(null);
        if (result.status === 'done') {
          await client.invalidateQueries({ queryKey: ['model', login.base] });
          if (!stopped && daemonBase() === login.base) {
            settle(null);
            onDone();
          }
          return;
        }
        if (result.status === 'failed') {
          settle(result.error);
          return;
        }
      } catch (err) {
        if (!stopped) setError(queryError(err, 'Could not check the sign-in. Retrying.'));
      }
      if (!stopped) timer = setTimeout(() => { tick().catch(() => { setError('Could not check the sign-in.'); }); }, 1500);
    };
    tick().catch(() => { setError('Could not check the sign-in.'); });
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [login, settle, onDone, client]);
  return error;
}

const signInError = (...errors: (string | null)[]): string | null => errors.find((error) => error !== null) ?? null;

function LoginFlow({ connection, onDone, children }: { connection: string; onDone: () => void; children: ReactNode }): ReactNode {
  const [manual, setManual] = useState(false);
  const dark = useKitScheme() === 'dark';
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const begin = async (): Promise<OpenRouterLogin> => {
    const login = await beginOpenRouterLogin(connection);
    if (!mounted.current) {
      await cancelOpenRouterLogin(login);
      throw new Error('OpenRouter sign-in cancelled.');
    }
    return login;
  };
  const { starting, started: login, link, error, start, settle } = useSignInTab(begin, (value) => value.url, 'Could not start OpenRouter sign-in.');
  useAttemptCleanup(login);
  const pollingError = usePolling(login, settle, onDone);
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const cancel = (): void => {
    if (login === null) return;
    setCancelling(true);
    setCancelError(null);
    cancelOpenRouterLogin(login).then((result) => {
      if (result.status !== 'done') settle(null);
    }).catch((err: unknown) => {
      setCancelError(queryError(err, 'Could not cancel the sign-in. Try again.'));
    }).finally(() => { setCancelling(false); });
  };
  const message = signInError(error, pollingError, cancelError);
  if (manual) return <Col gap={16}>{children}<TextLink size="2xs" onPress={() => { setManual(false); }}>Sign in instead</TextLink></Col>;
  return (
    <Col gap={10}>
      <SignInLink link={login === null ? null : link} label="Open the OpenRouter sign-in">
        <Button size="lg" dark={dark} label="Continue with OpenRouter" loading={starting} disabled={starting || login !== null} onPress={start} />
      </SignInLink>
      <Text size="2xs" role="secondary">Authorize Metro in your browser. The generated API key stays on this box.</Text>
      {connection === '' ? null : <Text size="2xs" role="secondary">Signing in again replaces this connection&apos;s key. Its model and fallbacks stay.</Text>}
      {login === null ? null : (
        <Col gap={8}>
          <Text size="2xs" role="secondary">Waiting for OpenRouter. Return here after approval. If you declined, cancel below.</Text>
          <Row><Button size="md" color="secondary" dark={dark} label="Cancel sign-in" loading={cancelling} disabled={cancelling} onPress={cancel} /></Row>
        </Col>
      )}
      {message === null ? null : <Text size="2xs" role="danger">{message}</Text>}
      {starting || login !== null ? null : <TextLink size="2xs" onPress={() => { setManual(true); }}>Use an API key</TextLink>}
    </Col>
  );
}

export function OpenRouterConnect({ connection, onDone, children }: { connection: string; onDone: () => void; children: ReactNode }): ReactNode {
  const version = useModeQuery().data?.version ?? null;
  if (!olderThan(version, OPENROUTER_LOGIN_SINCE)) return <LoginFlow connection={connection} onDone={onDone}>{children}</LoginFlow>;
  return <Col gap={16}><Text size="2xs" role="secondary">Update Metro on this box to sign in with OpenRouter. You can still use an API key.</Text>{children}</Col>;
}
