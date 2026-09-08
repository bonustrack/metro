import { type ReactNode, useEffect, useState } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Text, Button, Input } from './ui.js';
import { FieldLabel } from './FieldLabel.js';
import { GROW } from '../theme.js';
import { answerClaudeLogin, cancelClaudeLogin, fetchClaudeAccount, pollClaudeLogin, startClaudeLogin, type ClaudeAccount, type ClaudeLogin } from '../api/claude.js';
import { queryError } from '../api/queries.js';

const FIELD_WIDTH = 420;
const POLL_MS = 1_500;
const WHAT =
  'This runs Claude Code’s own sign-in on the machine, and shows you what it prints. The login belongs to Claude Code and is stored where it puts it; metro never holds it and never talks to Anthropic’s login servers.';

function useLoginPolling(login: ClaudeLogin | null, onUpdate: (next: ClaudeLogin) => void, onError: (message: string) => void): void {
  useEffect(() => {
    if (login?.state !== 'pending') return undefined;
    let stopped = false;
    const timer = setInterval(() => {
      pollClaudeLogin(login.id)
        .then((next) => {
          if (!stopped) onUpdate(next);
        })
        .catch((err: unknown) => {
          if (!stopped) onError(queryError(err, 'The sign-in stopped answering.'));
        });
    }, POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [login, onUpdate, onError]);
}

function Waiting({ login, onCode }: { login: ClaudeLogin; onCode: (code: string) => void }): ReactNode {
  const dark = useKitScheme() === 'dark';
  const [code, setCode] = useState('');
  return (
    <Col gap={8} maxWidth={FIELD_WIDTH}>
      {login.url === null ? (
        <Text size="sm" role="secondary">
          Waiting for the sign-in to print its address…
        </Text>
      ) : (
        <Text size="sm">
          <a className="hint-link" href={login.url} target="_blank" rel="noreferrer">
            Open the Anthropic sign-in
          </a>
        </Text>
      )}
      <Text size="sm" role="secondary">
        Finish it in that tab. If it asks you to paste a code back, put it here.
      </Text>
      <Input
        name="claude-login-code"
        value={code}
        placeholder="the code the sign-in gives you"
        dark={dark}
        onChangeText={setCode}
        style={GROW}
        inputProps={{ autoCapitalize: 'none', autoComplete: 'off', autoCorrect: false, spellCheck: false }}
      />
      <Row gap={8} wrap>
        <Button
          size="sm"
          dark={dark}
          label="Send it"
          disabled={code.trim() === ''}
          onPress={() => {
            onCode(code.trim());
            setCode('');
          }}
        />
      </Row>
      {login.output === '' ? null : (
        <pre className="login-output">{login.output.slice(-1200)}</pre>
      )}
    </Col>
  );
}

export function ClaudeLoginCard(): ReactNode {
  const dark = useKitScheme() === 'dark';
  const [account, setAccount] = useState<ClaudeAccount | null>(null);
  const [login, setLogin] = useState<ClaudeLogin | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refresh = (): void => {
    fetchClaudeAccount()
      .then(setAccount)
      .catch(() => undefined);
  };
  useEffect(refresh, []);
  useLoginPolling(login, (next) => {
    setLogin(next.state === 'pending' ? next : null);
    if (next.state === 'failed') setError(next.error ?? 'The sign-in did not finish.');
    if (next.state === 'done') refresh();
  }, setError);
  const begin = (): void => {
    setBusy(true);
    setError(null);
    startClaudeLogin()
      .then(setLogin)
      .catch((err: unknown) => {
        setError(queryError(err, 'Could not start the sign-in.'));
      })
      .finally(() => {
        setBusy(false);
      });
  };
  const send = (code: string): void => {
    if (login === null) return;
    answerClaudeLogin(login.id, code)
      .then(setLogin)
      .catch((err: unknown) => {
        setError(queryError(err, 'Could not send the code.'));
      });
  };
  const stop = (): void => {
    if (login === null) return;
    const { id } = login;
    setLogin(null);
    cancelClaudeLogin(id).catch(() => undefined);
  };
  if (account !== null && !account.available)
    return (
      <Col gap={4}>
        <FieldLabel>Claude Code sign-in</FieldLabel>
        <Text size="sm" role="secondary">
          Claude Code is not installed on this machine, so there is nothing to sign in.
        </Text>
      </Col>
    );
  return (
    <Col gap={8}>
      <FieldLabel>Claude Code sign-in</FieldLabel>
      <Text size="sm">
        {account === null ? 'Asking the machine…' : account.signedIn ? `Signed in${account.account === null ? '' : ` as ${account.account}`}` : 'Not signed in on this machine.'}
      </Text>
      <Text size="sm" role="secondary">
        {WHAT}
      </Text>
      {login === null ? (
        <Row gap={8} wrap>
          <Button
            size="sm"
            color="secondary"
            dark={dark}
            label={account?.signedIn === true ? 'Sign in again' : 'Sign in with a Claude subscription'}
            loading={busy}
            disabled={busy}
            onPress={begin}
          />
        </Row>
      ) : (
        <Col gap={8}>
          <Waiting login={login} onCode={send} />
          <Row gap={8} wrap>
            <Button size="sm" color="secondary" dark={dark} label="Cancel" onPress={stop} />
          </Row>
        </Col>
      )}
      {error === null ? null : (
        <Text size="sm" role="danger">
          {error}
        </Text>
      )}
    </Col>
  );
}
