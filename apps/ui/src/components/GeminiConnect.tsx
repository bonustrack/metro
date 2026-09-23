import { type ReactNode, useState } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Text, Button, Input } from './ui.js';
import { FieldLabel } from './FieldLabel.js';
import { GROW } from '../theme.js';
import { beginGeminiLogin, finishGeminiLogin, type ConnectionRow } from '../api/model.js';
import { useModelAction, useSignInTab } from './sign-in-tab.js';

const FIELD_WIDTH = 420;
const PASTE_HINT = 'Google ends on a localhost:51121 address that will not load. Paste that whole address here.';
const WHICH_ACCOUNT = 'Use the account with your Google AI plan. Metro presents itself as Google Antigravity, which Google does not support.';
const PROJECT_HINT = 'Optional: a Google Cloud project with a Gemini Code Assist licence. Empty for a personal account.';

function PasteCode({ state, project, id }: { state: string; project: string; id: string }): ReactNode {
  const dark = useKitScheme() === 'dark';
  const { busy, error, run } = useModelAction();
  const [code, setCode] = useState('');
  return (
    <Col gap={6} maxWidth={FIELD_WIDTH}>
      <Text size="sm" role="secondary">
        {PASTE_HINT}
      </Text>
      <Input name="gemini-code" value={code} placeholder="http://localhost:51121/oauth-callback?code=…" dark={dark} onChangeText={setCode} style={GROW} />
      <Row gap={8}>
        <Button
          size="sm"
          dark={dark}
          label={busy ? 'Finishing…' : 'Finish sign-in'}
          loading={busy}
          disabled={busy || code.trim() === ''}
          onPress={() => {
            run(() => finishGeminiLogin(code, state, project, id), 'Could not finish the sign-in.');
          }}
        />
      </Row>
      {error !== null ? <Text size="sm" role="danger">{error}</Text> : null}
    </Col>
  );
}

function SignInFlow({ label, color, id }: { label: string; color: 'primary' | 'secondary'; id: string }): ReactNode {
  const dark = useKitScheme() === 'dark';
  const [project, setProject] = useState('');
  const { starting, started, link, error, start: connect } = useSignInTab(beginGeminiLogin, (login) => login.url, 'Could not start the Google sign-in.');
  return (
    <Col gap={10}>
      <Col gap={6} maxWidth={FIELD_WIDTH}>
        <FieldLabel>Google Cloud project (optional)</FieldLabel>
        <Input name="gemini-project" value={project} placeholder="my-project-123456" dark={dark} onChangeText={setProject} style={GROW} />
        <Text size="sm" role="secondary">
          {PROJECT_HINT}
        </Text>
      </Col>
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
      {started === null ? null : <PasteCode state={started.state} project={project.trim()} id={id} />}
      {error !== null ? <Text size="sm" role="danger">{error}</Text> : null}
    </Col>
  );
}

function SignedIn({ gemini }: { gemini: ConnectionRow }): ReactNode {
  return (
    <Col gap={10}>
      <Text size="sm">
        Signed in{gemini.account === null ? '' : ` as ${gemini.account}`}
        {gemini.plan === null ? '' : ` (${gemini.plan})`}
      </Text>
      <SignInFlow label="Connect again" color="secondary" id={gemini.id} />
    </Col>
  );
}

export function GeminiConnect({ gemini }: { gemini: ConnectionRow | null }): ReactNode {
  return (
    <Col gap={4}>
      <FieldLabel>Google account</FieldLabel>
      {gemini?.signedIn === true ? (
        <SignedIn gemini={gemini} />
      ) : (
        <Col gap={10}>
          <Text size="sm" role="secondary">
            Not connected. {WHICH_ACCOUNT}
          </Text>
          <SignInFlow label="Connect Google" color="primary" id={gemini?.id ?? ''} />
        </Col>
      )}
    </Col>
  );
}
