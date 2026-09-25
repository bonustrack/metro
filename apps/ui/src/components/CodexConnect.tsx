import { type ReactNode, useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Text, Button } from './ui.js';
import { FieldLabel } from './FieldLabel.js';
import { beginCodexDevice, beginCodexLogin, codexImport, finishCodexLogin, pollCodexDevice, type ConnectionRow, type DeviceLogin } from '../api/model.js';
import { queryError, refresh } from '../api/queries.js';
import { useModelAction, useSignInTab } from './sign-in-tab.js';
import { PasteAddress, SignedInAs, SignInLink } from './ProviderSignIn.js';

const SIGN_IN_LINK = 'Open the ChatGPT sign-in';
const START_FAILED = 'Could not start the ChatGPT sign-in.';
const PASTE_HINT = 'The sign-in ends on a localhost:1455 address that will not load. Paste that whole address here.';

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
  }, [login, client, settle]);
}

function DeviceFlow({ label, id }: { label: string; id: string }): ReactNode {
  const dark = useKitScheme() === 'dark';
  const { starting, started: login, link, error, start: connect, settle } = useSignInTab(beginCodexDevice, (started) => started.verifyUrl, START_FAILED);
  useDevicePolling(login, id, settle);
  return (
    <Col gap={10}>
      <SignInLink link={link} label={SIGN_IN_LINK}>
        <Button size="sm" dark={dark} label={label} loading={starting} disabled={starting || login !== null} onPress={connect} />
      </SignInLink>
      {login !== null ? (
        <Col gap={4}>
          <Text size="sm">Enter this code on the ChatGPT page that opened:</Text>
          <Text>{login.userCode}</Text>
          <Text size="sm" role="secondary">
            Waiting for ChatGPT to confirm. This page finishes on its own.
          </Text>
        </Col>
      ) : null}
      {error !== null ? <Text size="sm" role="danger">{error}</Text> : null}
    </Col>
  );
}

function RedirectFlow({ label, id }: { label: string; id: string }): ReactNode {
  const dark = useKitScheme() === 'dark';
  const { starting, started, link, error, start: connect } = useSignInTab(beginCodexLogin, (url) => url, START_FAILED);
  return (
    <Col gap={10}>
      <SignInLink link={link} label={SIGN_IN_LINK}>
        <Button size="sm" color="secondary" dark={dark} label={label} loading={starting} disabled={starting} onPress={connect} />
      </SignInLink>
      {started === null ? null : <PasteAddress hint={PASTE_HINT} name="codex-callback" placeholder="http://localhost:1455/auth/callback?code=…&state=…" finish={(pasted) => finishCodexLogin(pasted, id)} />}
      {error !== null ? <Text size="sm" role="danger">{error}</Text> : null}
    </Col>
  );
}

function NotConnected({ id }: { id: string }): ReactNode {
  const dark = useKitScheme() === 'dark';
  const { busy, error, run } = useModelAction();
  return (
    <Col gap={10}>
      <Text size="sm" role="secondary">
        Not connected.
      </Text>
      <DeviceFlow label="Connect ChatGPT" id={id} />
      <Text size="sm" role="secondary">
        Other ways in:
      </Text>
      <RedirectFlow label="Sign in through a browser redirect" id={id} />
      <Row gap={8} wrap>
        <Button size="sm" color="secondary" dark={dark} label="Use the Codex CLI login on this machine" disabled={busy} onPress={() => { run(() => codexImport(id), 'Could not read the Codex CLI login.'); }} />
      </Row>
      {error !== null ? <Text size="sm" role="danger">{error}</Text> : null}
    </Col>
  );
}

export function CodexConnect({ codex }: { codex: ConnectionRow | null }): ReactNode {
  return (
    <Col gap={4}>
      <FieldLabel>ChatGPT account</FieldLabel>
      {codex?.signedIn === true ? (
        <SignedInAs connection={codex}>
          <DeviceFlow label="Connect again" id={codex.id} />
        </SignedInAs>
      ) : <NotConnected id={codex?.id ?? ''} />}
    </Col>
  );
}
