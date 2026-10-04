import { type ReactNode, useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Col } from '@stage-labs/kit/react-native/box';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Button } from '@stage-labs/kit/react-native/button';
import { Text } from '@stage-labs/kit/react-native/text';
import { FieldLabel } from './FieldLabel.js';
import {
  beginCodexDevice,
  beginCodexLogin,
  carriesCodeAndState,
  CHATGPT_USAGE_URL,
  CODEX_CODE_SINCE,
  finishCodexLogin,
  pollCodexDevice,
  type CodexMethod,
  type ConnectionRow,
  type DeviceLogin,
} from '@metro-labs/client/api/model';
import { olderThan } from '@metro-labs/client/api/version';
import { queryError, refresh, useModeQuery } from '../lib/queries.js';
import { useSignInTab } from './sign-in-tab.js';
import { PasteAddress, SignedInAs, SignInLink } from './ProviderSignIn.js';
import { TextLink } from './TextLink.js';

type Color = 'primary' | 'secondary';

const SIGN_IN_LINK = 'Open the ChatGPT sign-in';
const START_FAILED = 'Could not start the ChatGPT sign-in.';
const LEAVE_NOTE = "After you sign in, ChatGPT opens a 127.0.0.1 page that will not load. That is normal: copy that page's whole address and paste it here.";
const PASTE_HINT = 'Metro finishes the sign-in as soon as you paste the address.';
const CODE_NOTE = "Uses the Codex app's sign-in (not in OpenAI's docs for other apps).";
const PLAN_NOTE = 'Not connected. It needs ChatGPT Plus or Pro, and requests then use your ChatGPT plan.';
const SIGN_IN_AGAIN = 'Not signed in. Sign in again with one of the options below. Your model and fallbacks stay.';
const HOW: Record<CodexMethod, string> = { chatgpt: 'with ChatGPT', code: 'with a code' };

function useDevicePolling(login: DeviceLogin | null, id: string, settle: (error: string | null) => void): void {
  const client = useQueryClient();
  useEffect(() => {
    if (login === null) return undefined;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = (): void => {
      pollCodexDevice(login.id, id)
        .then(async (result) => {
          if (stopped) return;
          if (result.status === 'pending') {
            timer = setTimeout(tick, login.interval * 1000);
            return;
          }
          if (result.status === 'done') await refresh(client, 'model');
          settle(result.status === 'failed' ? result.error : null);
        })
        .catch((err: unknown) => {
          if (!stopped) settle(queryError(err, 'The sign-in did not finish.'));
        });
    };
    timer = setTimeout(tick, login.interval * 1000);
    return () => {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
    };
  }, [login, id, client, settle]);
}

function ChatgptFlow({ color, id }: { color: Color; id: string }): ReactNode {
  const dark = useKitScheme() === 'dark';
  const { starting, started, link, error, start } = useSignInTab(() => beginCodexLogin(id), (url) => url, START_FAILED);
  return (
    <Col gap={10}>
      <SignInLink link={link} label={SIGN_IN_LINK}>
        <Button size="md" color={color} dark={dark} label="Continue with ChatGPT" loading={starting} disabled={starting} onPress={start} />
      </SignInLink>
      <Text size="2xs" role="secondary">
        {LEAVE_NOTE}
      </Text>
      {started === null ? null : (
        <PasteAddress
          hint={PASTE_HINT}
          name="codex-callback"
          placeholder="http://127.0.0.1:1455/auth/callback?code=…&state=…"
          ready={carriesCodeAndState}
          finish={(pasted) => finishCodexLogin(pasted, id)}
        />
      )}
      {error !== null ? <Text size="2xs" role="danger">{error}</Text> : null}
    </Col>
  );
}

function CodeFlow({ id }: { id: string }): ReactNode {
  const dark = useKitScheme() === 'dark';
  const { starting, started: login, link, error, start, settle } = useSignInTab(beginCodexDevice, (started) => started.verifyUrl, START_FAILED);
  useDevicePolling(login, id, settle);
  return (
    <Col gap={10}>
      <SignInLink link={link} label={SIGN_IN_LINK}>
        <Button size="md" color="secondary" dark={dark} label="Sign in with a code" loading={starting} disabled={starting || login !== null} onPress={start} />
      </SignInLink>
      <Text size="2xs" role="secondary">
        {CODE_NOTE}
      </Text>
      {login !== null ? (
        <Col gap={4}>
          <Text size="2xs">Enter this code on the ChatGPT page that opened:</Text>
          <Text size="xs">{login.userCode}</Text>
          <Text size="2xs" role="secondary">
            Waiting for ChatGPT to confirm. This page finishes on its own.
          </Text>
        </Col>
      ) : null}
      {error !== null ? <Text size="2xs" role="danger">{error}</Text> : null}
    </Col>
  );
}

function CodeOption({ id }: { id: string }): ReactNode {
  const mode = useModeQuery();
  if (olderThan(mode.data?.version ?? null, CODEX_CODE_SINCE))
    return (
      <Text size="2xs" role="secondary">
        {`Sign in with a code needs metro ${CODEX_CODE_SINCE}. Update first, from the Server page.`}
      </Text>
    );
  return <CodeFlow id={id} />;
}

function SignInOptions({ color, id }: { color: Color; id: string }): ReactNode {
  return (
    <Col gap={20}>
      <ChatgptFlow color={color} id={id} />
      <CodeOption id={id} />
    </Col>
  );
}

export function CodexConnect({ codex }: { codex: ConnectionRow | null }): ReactNode {
  return (
    <Col gap={4}>
      <FieldLabel>ChatGPT account</FieldLabel>
      {codex?.signedIn === true ? (
        <SignedInAs connection={codex} how={codex.method === null ? '' : HOW[codex.method]}>
          <TextLink size="2xs" url={CHATGPT_USAGE_URL}>Manage usage in ChatGPT</TextLink>
          <SignInOptions color="secondary" id={codex.id} />
        </SignedInAs>
      ) : (
        <Col gap={10}>
          <Text size="2xs" role={codex === null ? 'secondary' : 'danger'}>
            {codex === null ? PLAN_NOTE : SIGN_IN_AGAIN}
          </Text>
          <SignInOptions color="primary" id={codex?.id ?? ''} />
        </Col>
      )}
    </Col>
  );
}
