import { type ReactNode, useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Text, Button, Input } from './ui';
import { FieldLabel } from './FieldLabel';
import { GROW } from '../theme';
import { beginCodexDevice, beginCodexLogin, codexImport, codexLogout, finishCodexLogin, pollCodexDevice, type DeviceLogin, type ModelSettings } from '../api/model';
import { queryError, refreshModel } from '../api/queries';

const FIELD_WIDTH = 420;
const PASTE_HINT =
  'When the ChatGPT sign-in finishes, the browser lands on a localhost:1455 address that cannot load: copy that whole address from the address bar and paste it here.';

function useAction(): { busy: boolean; error: string | null; run: (job: () => Promise<unknown>, fallback: string) => void } {
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = (job: () => Promise<unknown>, fallback: string): void => {
    setBusy(true);
    setError(null);
    job()
      .then(() => refreshModel(client))
      .catch((err: unknown) => {
        setError(queryError(err, fallback));
      })
      .finally(() => {
        setBusy(false);
      });
  };
  return { busy, error, run };
}

function useDevicePolling(login: DeviceLogin | null, settle: (error: string | null) => void): void {
  const client = useQueryClient();
  useEffect(() => {
    if (login === null) return undefined;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = (): void => {
      pollCodexDevice(login.id)
        .then(async (result) => {
          if (stopped) return;
          if (result.status === 'pending') {
            timer = setTimeout(tick, login.interval * 1000);
            return;
          }
          if (result.status === 'done') await refreshModel(client);
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

function DeviceFlow({ label }: { label: string }): ReactNode {
  const dark = useKitScheme() === 'dark';
  const [starting, setStarting] = useState(false);
  const [login, setLogin] = useState<DeviceLogin | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const settle = (message: string | null): void => {
    setLogin(null);
    setError(message);
  };
  useDevicePolling(login, settle);
  const connect = (): void => {
    const tab = window.open('', '_blank');
    setStarting(true);
    setError(null);
    setLink(null);
    beginCodexDevice()
      .then((started) => {
        if (tab !== null) tab.location.assign(started.verifyUrl);
        else setLink(started.verifyUrl);
        setLogin(started);
      })
      .catch((err: unknown) => {
        tab?.close();
        setError(queryError(err, 'Could not start the ChatGPT sign-in.'));
      })
      .finally(() => {
        setStarting(false);
      });
  };
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

function PasteBack(): ReactNode {
  const dark = useKitScheme() === 'dark';
  const { busy, error, run } = useAction();
  const [pasted, setPasted] = useState('');
  return (
    <Col gap={6} maxWidth={FIELD_WIDTH}>
      <Text size="sm" role="secondary">
        {PASTE_HINT}
      </Text>
      <Input name="codex-callback" value={pasted} placeholder="http://localhost:1455/auth/callback?code=…&state=…" dark={dark} onChangeText={setPasted} style={GROW} />
      <Row gap={8}>
        <Button size="sm" dark={dark} label={busy ? 'Finishing…' : 'Finish sign-in'} loading={busy} disabled={busy || pasted.trim() === ''} onPress={() => { run(() => finishCodexLogin(pasted), 'Could not finish the sign-in.'); }} />
      </Row>
      {error !== null ? <Text size="sm" role="danger">{error}</Text> : null}
    </Col>
  );
}

function RedirectFlow({ label }: { label: string }): ReactNode {
  const dark = useKitScheme() === 'dark';
  const [starting, setStarting] = useState(false);
  const [started, setStarted] = useState(false);
  const [link, setLink] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const connect = (): void => {
    const tab = window.open('', '_blank');
    setStarting(true);
    setError(null);
    beginCodexLogin()
      .then((url) => {
        if (tab !== null) tab.location.assign(url);
        else setLink(url);
        setStarted(true);
      })
      .catch((err: unknown) => {
        tab?.close();
        setError(queryError(err, 'Could not start the ChatGPT sign-in.'));
      })
      .finally(() => {
        setStarting(false);
      });
  };
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
      {started ? <PasteBack /> : null}
      {error !== null ? <Text size="sm" role="danger">{error}</Text> : null}
    </Col>
  );
}

function SignedIn({ codex }: { codex: ModelSettings['codex'] }): ReactNode {
  const dark = useKitScheme() === 'dark';
  const { busy, error, run } = useAction();
  return (
    <Col gap={10}>
      <Text size="sm">
        Signed in{codex.account === null ? '' : ` as ${codex.account}`}
        {codex.plan === null ? '' : ` (${codex.plan})`}
      </Text>
      <Row gap={8} wrap align="center">
        <Button size="sm" color="secondary" dark={dark} label="Sign out" disabled={busy} onPress={() => { run(codexLogout, 'Could not sign out.'); }} />
      </Row>
      <DeviceFlow label="Connect again" />
      {error !== null ? <Text size="sm" role="danger">{error}</Text> : null}
    </Col>
  );
}

function NotConnected(): ReactNode {
  const dark = useKitScheme() === 'dark';
  const { busy, error, run } = useAction();
  return (
    <Col gap={10}>
      <Text size="sm" role="secondary">
        Not connected.
      </Text>
      <DeviceFlow label="Connect ChatGPT" />
      <Text size="sm" role="secondary">
        Other ways in:
      </Text>
      <RedirectFlow label="Sign in through a browser redirect" />
      <Row gap={8} wrap>
        <Button size="sm" color="secondary" dark={dark} label="Use the Codex CLI login on this machine" disabled={busy} onPress={() => { run(codexImport, 'Could not read the Codex CLI login.'); }} />
      </Row>
      {error !== null ? <Text size="sm" role="danger">{error}</Text> : null}
    </Col>
  );
}

export function CodexConnect({ codex }: { codex: ModelSettings['codex'] }): ReactNode {
  return (
    <Col gap={4}>
      <FieldLabel>ChatGPT account</FieldLabel>
      {codex.signedIn ? <SignedIn codex={codex} /> : <NotConnected />}
    </Col>
  );
}
