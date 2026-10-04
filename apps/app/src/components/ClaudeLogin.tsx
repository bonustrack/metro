import { type ReactNode, useEffect, useState } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Button } from '@stage-labs/kit/react-native/button';
import { FormField } from './FormField.js';
import { Text } from '@stage-labs/kit/react-native/text';
import { FieldLabel } from './FieldLabel.js';
import { GROW } from '../lib/style.js';
import { answerClaudeLogin, cancelClaudeLogin, fetchClaudeAccount, OWN_LOGINS_SINCE, pollClaudeLogin, startClaudeLogin, type ClaudeAccount, type ClaudeLogin } from '@metro-labs/client/api/claude';
import { queryError, useModeQuery } from '../lib/queries.js';
import { olderThan } from '@metro-labs/client/api/version';
import type { ConnectionRow } from '@metro-labs/client/api/model';
import { TextLink } from './TextLink.js';
import { LogBlock } from './ui/LogBlock.js';

const FIELD_WIDTH = 420;
const POLL_MS = 1_500;
const WHAT = 'Runs Claude Code’s own sign-in. Each account keeps its own login on the machine, so you can add as many as you like.';
const NEW_LOGIN = 'Each Claude account you sign in with becomes its own provider.';

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
        <Text size="2xs" role="secondary">
          Waiting for the sign-in to print its address…
        </Text>
      ) : (
        <TextLink size="2xs" url={login.url}>Open the Anthropic sign-in</TextLink>
      )}
      <Text size="2xs" role="secondary">
        Finish it in that tab. If it asks you to paste a code back, put it here.
      </Text>
      <FormField label="Sign-in code"
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
          size="lg"
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
        <LogBlock text={login.output.slice(-1200)} maxHeight={160} muted />
      )}
    </Col>
  );
}

function Note({ text }: { text: string }): ReactNode {
  return (
    <Col gap={4}>
      <FieldLabel>Claude subscription</FieldLabel>
      <Text size="2xs" role="secondary">
        {text}
      </Text>
    </Col>
  );
}

function statusLine(connection: ConnectionRow | null, account: ClaudeAccount | null): string {
  if (connection === null) return NEW_LOGIN;
  if (connection.signedIn) return `Signed in${connection.account === null ? '' : ` as ${connection.account}`}${connection.plan === null ? '' : ` (${connection.plan})`}`;
  const machine = account?.signedIn === true && account.account !== null ? ` (${account.account})` : '';
  return `Uses the Claude Code login of this machine${machine}. Sign in to give it a login of its own.`;
}

export function ClaudeLoginCard({ connection, onDone }: { connection: ConnectionRow | null; onDone: () => void }): ReactNode {
  const dark = useKitScheme() === 'dark';
  const [account, setAccount] = useState<ClaudeAccount | null>(null);
  const [login, setLogin] = useState<ClaudeLogin | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mode = useModeQuery();
  useEffect(() => {
    fetchClaudeAccount()
      .then(setAccount)
      .catch(() => undefined);
  }, []);
  useLoginPolling(login, (next) => {
    setLogin(next.state === 'pending' ? next : null);
    if (next.state === 'failed') setError(next.error ?? 'The sign-in did not finish.');
    if (next.state === 'done') onDone();
  }, setError);
  const begin = (): void => {
    setBusy(true);
    setError(null);
    startClaudeLogin(connection?.id ?? 'new')
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
  if (olderThan(mode.data?.version ?? null, OWN_LOGINS_SINCE)) return <Note text={`Needs metro ${OWN_LOGINS_SINCE}. Update first, from the Server page.`} />;
  if (account !== null && !account.available) return <Note text="Claude Code is not installed on this machine, so there is nothing to sign in." />;
  return (
    <Col gap={8}>
      <FieldLabel>Claude subscription</FieldLabel>
      <Text size="2xs">{statusLine(connection, account)}</Text>
      <Text size="2xs" role="secondary">
        {WHAT}
      </Text>
      {login === null ? (
        <Row gap={8} wrap>
          <Button
            size="md"
            color="secondary"
            dark={dark}
            label={connection?.signedIn === true ? 'Sign in again' : 'Sign in with a Claude subscription'}
            loading={busy}
            disabled={busy}
            onPress={begin}
          />
        </Row>
      ) : (
        <Col gap={8}>
          <Waiting login={login} onCode={send} />
          <Row gap={8} wrap>
            <Button size="md" color="secondary" dark={dark} label="Cancel" onPress={stop} />
          </Row>
        </Col>
      )}
      {error === null ? null : (
        <Text size="2xs" role="danger">
          {error}
        </Text>
      )}
    </Col>
  );
}
