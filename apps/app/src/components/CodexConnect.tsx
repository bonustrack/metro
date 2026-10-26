import { type ReactNode, useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Column } from '@stage-labs/kit/react-native/column';
import { Button } from '@stage-labs/kit/react-native/button';
import { Text } from '@stage-labs/kit/react-native/text';
import { FieldLabel } from './FieldLabel.js';
import { carriesCodeAndState, CHATGPT_USAGE_URL, type CodexMethod, type ConnectionRow } from '@metro-labs/client/api/model';
import { beginOrgCodexDevice, beginOrgCodexLogin, finishOrgCodexLogin, pollOrgCodexDevice, type DeviceLogin } from '@metro-labs/client/api/org-models';
import { queryError } from '../lib/queries.js';
import { afterModelChange } from '../lib/model-queries.js';
import { useSignInTab } from './sign-in-tab.js';
import { PasteAddress, SignedInAs, SignInLink } from './ProviderSignIn.js';
import { TextLink } from './TextLink.js';

type Color = 'primary' | 'secondary';

const SIGN_IN_LINK = 'Open the ChatGPT sign-in';
const START_FAILED = 'Could not start the ChatGPT sign-in.';
const LEAVE_NOTE = "After you sign in, ChatGPT opens a 127.0.0.1 page that will not load. That is normal: copy that page's whole address and paste it here.";
const PASTE_HINT = 'Metro finishes the sign-in as soon as you paste the address.';
const CODE_NOTE = "Uses the Codex app's sign-in (not in OpenAI's docs for other apps).";
const PLAN_NOTE = 'Needs ChatGPT Plus or Pro, and uses that plan.';
const SIGN_IN_AGAIN = 'Signed out. Sign in again below. The model order stays.';
const HOW: Record<CodexMethod, string> = { chatgpt: 'with ChatGPT', code: 'with a code' };

function useDevicePolling(login: DeviceLogin | null, settle: (error: string | null) => void, onDone: () => void): void {
  const client = useQueryClient();
  const done = useRef(onDone);
  useEffect(() => {
    done.current = onDone;
  }, [onDone]);
  useEffect(() => {
    if (login === null) return undefined;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = (): void => {
      pollOrgCodexDevice(login.id)
        .then(async (result) => {
          if (stopped) return;
          if (result.status === 'pending') {
            timer = setTimeout(tick, login.interval * 1000);
            return;
          }
          if (result.status === 'done') await afterModelChange(client);
          settle(result.status === 'failed' ? result.error : null);
          if (result.status === 'done') done.current();
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
  }, [login, client, settle]);
}

function ChatgptFlow({ color, id, onDone }: { color: Color; id: string; onDone: () => void }): ReactNode {
  const { starting, started, link, error, start } = useSignInTab(() => beginOrgCodexLogin(id), (url) => url, START_FAILED);
  return (
    <Column gap={10}>
      <SignInLink link={link} label={SIGN_IN_LINK}>
        <Button size="md" color={color} label="Continue with ChatGPT" loading={starting} disabled={starting} onPress={start} />
      </SignInLink>
      <Text size="md" color="secondary">
        {LEAVE_NOTE}
      </Text>
      {started === null ? null : (
        <PasteAddress
          hint={PASTE_HINT}
          name="codex-callback"
          placeholder="http://127.0.0.1:1455/auth/callback?code=…&state=…"
          ready={carriesCodeAndState}
          finish={finishOrgCodexLogin}
          onDone={onDone}
        />
      )}
      {error !== null ? <Text size="md" color="danger">{error}</Text> : null}
    </Column>
  );
}

function CodeFlow({ id, onDone }: { id: string; onDone: () => void }): ReactNode {
  const { starting, started: login, link, error, start, settle } = useSignInTab(() => beginOrgCodexDevice(id), (started) => started.verifyUrl, START_FAILED);
  useDevicePolling(login, settle, onDone);
  return (
    <Column gap={10}>
      <SignInLink link={link} label={SIGN_IN_LINK}>
        <Button size="md" color="secondary" label="Sign in with a code" loading={starting} disabled={starting || login !== null} onPress={start} />
      </SignInLink>
      <Text size="md" color="secondary">
        {CODE_NOTE}
      </Text>
      {login !== null ? (
        <Column gap={4}>
          <Text size="md">Enter this code on the ChatGPT page that opened:</Text>
          <Text size="xs">{login.userCode}</Text>
          <Text size="md" color="secondary">
            Waiting for ChatGPT to confirm. This page finishes on its own.
          </Text>
        </Column>
      ) : null}
      {error !== null ? <Text size="md" color="danger">{error}</Text> : null}
    </Column>
  );
}

function SignInOptions({ color, id, onDone }: { color: Color; id: string; onDone: () => void }): ReactNode {
  return (
    <Column gap={20}>
      <ChatgptFlow color={color} id={id} onDone={onDone} />
      <CodeFlow id={id} onDone={onDone} />
    </Column>
  );
}

export function CodexConnect({ codex, onDone }: { codex: ConnectionRow | null; onDone: () => void }): ReactNode {
  return (
    <Column gap={4}>
      <FieldLabel>ChatGPT account</FieldLabel>
      {codex !== null && !codex.signedOut ? (
        <SignedInAs connection={codex} how={codex.method === null ? '' : HOW[codex.method]}>
          <TextLink size="md" url={CHATGPT_USAGE_URL}>Manage usage in ChatGPT</TextLink>
          <SignInOptions color="secondary" id={codex.id} onDone={onDone} />
        </SignedInAs>
      ) : (
        <Column gap={10}>
          <Text size="md" color={codex === null ? 'secondary' : 'danger'}>
            {codex === null ? PLAN_NOTE : SIGN_IN_AGAIN}
          </Text>
          <SignInOptions color="primary" id={codex?.id ?? ''} onDone={onDone} />
        </Column>
      )}
    </Column>
  );
}
