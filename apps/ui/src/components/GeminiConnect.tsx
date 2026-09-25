import { type ReactNode, useState } from 'react';
import { Col } from '@stage-labs/kit/react-native/box';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Text, Button, Input } from './ui.js';
import { FieldLabel } from './FieldLabel.js';
import { GROW } from '../theme.js';
import { beginGeminiLogin, finishGeminiLogin, type ConnectionRow } from '../api/model.js';
import { useSignInTab } from './sign-in-tab.js';
import { FIELD_WIDTH, PasteAddress, SignedInAs, SignInLink } from './ProviderSignIn.js';

const PASTE_HINT = 'Google ends on a localhost:51121 address that will not load. Paste that whole address here.';
const WHICH_ACCOUNT = 'Use the account with your Google AI plan. Metro presents itself as Google Antigravity, which Google does not support.';
const PROJECT_HINT = 'Optional: a Google Cloud project with a Gemini Code Assist licence. Empty for a personal account.';

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
      <SignInLink link={link} label="Open the Google sign-in">
        <Button size="sm" color={color} dark={dark} label={label} loading={starting} disabled={starting} onPress={connect} />
      </SignInLink>
      {started === null ? null : (
        <PasteAddress
          hint={PASTE_HINT}
          name="gemini-code"
          placeholder="http://localhost:51121/oauth-callback?code=…"
          finish={(code) => finishGeminiLogin(code, started.state, project.trim(), id)}
        />
      )}
      {error !== null ? <Text size="sm" role="danger">{error}</Text> : null}
    </Col>
  );
}

export function GeminiConnect({ gemini }: { gemini: ConnectionRow | null }): ReactNode {
  return (
    <Col gap={4}>
      <FieldLabel>Google account</FieldLabel>
      {gemini?.signedIn === true ? (
        <SignedInAs connection={gemini}>
          <SignInFlow label="Connect again" color="secondary" id={gemini.id} />
        </SignedInAs>
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
