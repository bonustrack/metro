import { type ReactNode, useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Text, Button, Input } from './ui.js';
import { FieldLabel } from './FieldLabel.js';
import { GROW } from '../theme.js';
import { beginCodexDevice, beginCodexLogin, codexImport, finishCodexLogin, pollCodexDevice, type ConnectionRow, type DeviceLogin } from '../api/model.js';
import { queryError, refresh } from '../api/queries.js';
import { useModelAction, useSignInTab } from './sign-in-tab.js';

const FIELD_WIDTH = 420;
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
      <Row gap={8} wrap align="center">
        <Button size="sm" dark={dark} label={label} loading={starting} disabled={starting || login !== null} onPress={connect} />
        {link !== null ? (
          <Text size="sm">
            <a className="hint-link" href={link} target="_blank" rel="noreferrer">
              Open the ChatGPT sign-in
            </a>
          </Text>
        ) : null}
      </Row>
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

function PasteBack({ id }: { id: string }): ReactNode {
  const dark = useKitScheme() === 'dark';
  const { busy, error, run } = useModelAction();
  const [pasted, setPasted] = useState('');
  return (
    <Col gap={6} maxWidth={FIELD_WIDTH}>
      <Text size="sm" role="secondary">
        {PASTE_HINT}
      </Text>
      <Input name="codex-callback" value={pasted} placeholder="http://localhost:1455/auth/callback?code=…&state=…" dark={dark} onChangeText={setPasted} style={GROW} />
      <Row gap={8}>
        <Button size="sm" dark={dark} label={busy ? 'Finishing…' : 'Finish sign-in'} loading={busy} disabled={busy || pasted.trim() === ''} onPress={() => { run(() => finishCodexLogin(pasted, id), 'Could not finish the sign-in.'); }} />
      </Row>
      {error !== null ? <Text size="sm" role="danger">{error}</Text> : null}
    </Col>
  );
}

function RedirectFlow({ label, id }: { label: string; id: string }): ReactNode {
  const dark = useKitScheme() === 'dark';
  const { starting, started, link, error, start: connect } = useSignInTab(beginCodexLogin, (url) => url, START_FAILED);
  return (
    <Col gap={10}>
      <Row gap={8} wrap align="center">
        <Button size="sm" color="secondary" dark={dark} label={label} loading={starting} disabled={starting} onPress={connect} />
        {link !== null ? (
          <Text size="sm">
            <a className="hint-link" href={link} target="_blank" rel="noreferrer">
              Open the ChatGPT sign-in
            </a>
          </Text>
        ) : null}
      </Row>
      {started === null ? null : <PasteBack id={id} />}
      {error !== null ? <Text size="sm" role="danger">{error}</Text> : null}
    </Col>
  );
}

function SignedIn({ codex }: { codex: ConnectionRow }): ReactNode {
  return (
    <Col gap={10}>
      <Text size="sm">
        Signed in{codex.account === null ? '' : ` as ${codex.account}`}
        {codex.plan === null ? '' : ` (${codex.plan})`}
      </Text>
      <DeviceFlow label="Connect again" id={codex.id} />
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
      {codex?.signedIn === true ? <SignedIn codex={codex} /> : <NotConnected id={codex?.id ?? ''} />}
    </Col>
  );
}
