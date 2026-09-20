import { type ReactNode, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Text, Button, Input } from './ui.js';
import { FieldLabel } from './FieldLabel.js';
import { GROW } from '../theme.js';
import { beginGeminiLogin, finishGeminiLogin, geminiLogout, type ModelSettings } from '../api/model.js';
import { queryError, refreshModel } from '../api/queries.js';

const FIELD_WIDTH = 420;
const PASTE_HINT = 'At the end Google shows a code on its page: copy it and paste it here.';
const WHICH_ACCOUNT = 'Use a personal Google account (gmail.com) that holds your Google AI Pro or Ultra plan. A Google Workspace account is refused by Google: that tier is for individuals only.';

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

function PasteCode({ state }: { state: string }): ReactNode {
  const dark = useKitScheme() === 'dark';
  const { busy, error, run } = useAction();
  const [code, setCode] = useState('');
  return (
    <Col gap={6} maxWidth={FIELD_WIDTH}>
      <Text size="sm" role="secondary">
        {PASTE_HINT}
      </Text>
      <Input name="gemini-code" value={code} placeholder="the code Google showed" dark={dark} onChangeText={setCode} style={GROW} />
      <Row gap={8}>
        <Button
          size="sm"
          dark={dark}
          label={busy ? 'Finishing…' : 'Finish sign-in'}
          loading={busy}
          disabled={busy || code.trim() === ''}
          onPress={() => {
            run(() => finishGeminiLogin(code, state), 'Could not finish the sign-in.');
          }}
        />
      </Row>
      {error !== null ? <Text size="sm" role="danger">{error}</Text> : null}
    </Col>
  );
}

function SignInFlow({ label, color }: { label: string; color: 'primary' | 'secondary' }): ReactNode {
  const dark = useKitScheme() === 'dark';
  const [starting, setStarting] = useState(false);
  const [started, setStarted] = useState<{ url: string; state: string } | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const connect = (): void => {
    const tab = window.open('', '_blank');
    setStarting(true);
    setError(null);
    beginGeminiLogin()
      .then((login) => {
        if (tab !== null) tab.location.assign(login.url);
        else setLink(login.url);
        setStarted(login);
      })
      .catch((err: unknown) => {
        tab?.close();
        setError(queryError(err, 'Could not start the Google sign-in.'));
      })
      .finally(() => {
        setStarting(false);
      });
  };
  return (
    <Col gap={10}>
      <Row gap={8} wrap align="center">
        <Button size="sm" color={color} dark={dark} label={label} loading={starting} disabled={starting} onPress={connect} />
        {link !== null ? (
          <Text size="sm">
            <a className="hint-link" href={link} target="_blank" rel="noreferrer">
              Open the Google sign-in
            </a>
          </Text>
        ) : null}
      </Row>
      {started === null ? null : <PasteCode state={started.state} />}
      {error !== null ? <Text size="sm" role="danger">{error}</Text> : null}
    </Col>
  );
}

function SignedIn({ gemini }: { gemini: ModelSettings['gemini'] }): ReactNode {
  const dark = useKitScheme() === 'dark';
  const { busy, error, run } = useAction();
  return (
    <Col gap={10}>
      <Text size="sm">
        Signed in{gemini.account === null ? '' : ` as ${gemini.account}`}
        {gemini.plan === null ? '' : ` (${gemini.plan})`}
      </Text>
      <Row gap={8} wrap align="center">
        <Button
          size="sm"
          color="secondary"
          dark={dark}
          label="Sign out"
          disabled={busy}
          onPress={() => {
            run(geminiLogout, 'Could not sign out.');
          }}
        />
      </Row>
      <SignInFlow label="Connect again" color="secondary" />
      {error !== null ? <Text size="sm" role="danger">{error}</Text> : null}
    </Col>
  );
}

export function GeminiConnect({ gemini }: { gemini: ModelSettings['gemini'] }): ReactNode {
  return (
    <Col gap={4}>
      <FieldLabel>Google account</FieldLabel>
      {gemini.signedIn ? (
        <SignedIn gemini={gemini} />
      ) : (
        <Col gap={10}>
          <Text size="sm" role="secondary">
            Not connected. {WHICH_ACCOUNT}
          </Text>
          <SignInFlow label="Connect Google" color="primary" />
        </Col>
      )}
    </Col>
  );
}
