import { type ReactNode } from 'react';
import { Col } from '@stage-labs/kit/react-native/box';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Button } from '@stage-labs/kit/react-native/button';
import { Text } from '@stage-labs/kit/react-native/text';
import { FieldLabel } from './FieldLabel.js';
import { beginCodexLogin, CHATGPT_USAGE_URL, finishCodexLogin, type ConnectionRow } from '@metro-labs/client/api/model';
import { useSignInTab } from './sign-in-tab.js';
import { PasteAddress, SignedInAs, SignInLink } from './ProviderSignIn.js';
import { TextLink } from './TextLink.js';

const PASTE_HINT = 'The sign-in ends on a 127.0.0.1:1455 address that will not load. Paste that whole address here.';
const PLAN_NOTE = 'Not connected. It needs ChatGPT Plus or Pro, and requests then use your ChatGPT plan.';
const SIGN_IN_AGAIN = "Sign in again. Metro now uses OpenAI's official Sign in with ChatGPT, so the old Codex login no longer works. Your model and fallbacks stay.";

function SignInFlow({ label, color, id }: { label: string; color: 'primary' | 'secondary'; id: string }): ReactNode {
  const dark = useKitScheme() === 'dark';
  const { starting, started, link, error, start: connect } = useSignInTab(() => beginCodexLogin(id), (url) => url, 'Could not start the ChatGPT sign-in.');
  return (
    <Col gap={10}>
      <SignInLink link={link} label="Open the ChatGPT sign-in">
        <Button size="md" color={color} dark={dark} label={label} loading={starting} disabled={starting} onPress={connect} />
      </SignInLink>
      {started === null ? null : (
        <PasteAddress hint={PASTE_HINT} name="codex-callback" placeholder="http://127.0.0.1:1455/auth/callback?code=…&state=…" finish={(pasted) => finishCodexLogin(pasted, id)} />
      )}
      {error !== null ? <Text size="2xs" role="danger">{error}</Text> : null}
    </Col>
  );
}

export function CodexConnect({ codex }: { codex: ConnectionRow | null }): ReactNode {
  return (
    <Col gap={4}>
      <FieldLabel>ChatGPT account</FieldLabel>
      {codex?.signedIn === true ? (
        <SignedInAs connection={codex}>
          <TextLink size="2xs" url={CHATGPT_USAGE_URL}>Manage usage in ChatGPT</TextLink>
          <SignInFlow label="Connect again" color="secondary" id={codex.id} />
        </SignedInAs>
      ) : (
        <Col gap={10}>
          <Text size="2xs" role={codex === null ? 'secondary' : 'danger'}>
            {codex === null ? PLAN_NOTE : SIGN_IN_AGAIN}
          </Text>
          <SignInFlow label="Continue with ChatGPT" color="primary" id={codex?.id ?? ''} />
        </Col>
      )}
    </Col>
  );
}
