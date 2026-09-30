import { type ReactNode, useState } from 'react';
import { Col } from '@stage-labs/kit/react-native/box';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Button } from '@stage-labs/kit/react-native/button';
import { Text } from '@stage-labs/kit/react-native/text';
import { agentsUrl } from '../api/client.js';
import { stateOf } from '../api/attach-session.js';
import { rememberSignIn } from '../api/sign-in-return.js';

interface BrowserSignInProps {
  agentId: string;
  attachId: string;
  authorizeUrl: string;
  provider: string;
  busy: boolean;
  onUseCode: (() => void) | null;
}

export function BrowserSignIn(props: BrowserSignInProps): ReactNode {
  const { agentId, attachId, authorizeUrl, provider, busy, onUseCode } = props;
  const dark = useKitScheme() === 'dark';
  const [opened, setOpened] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const open = (): void => {
    rememberSignIn({
      state: stateOf(authorizeUrl),
      agentsBase: agentsUrl(),
      agentId,
      attachId,
      backHash: window.location.hash,
      startedAt: Date.now(),
    });
    const tab = window.open(authorizeUrl, '_blank');
    setBlocked(tab === null);
    setOpened(true);
  };
  return (
    <Col gap={10}>
      <Button color="primary" dark={dark} onPress={open} disabled={busy} label={`Sign in with ${provider}`} />
      {blocked ? (
        <Text size="md">
          <a className="hint-link" href={authorizeUrl} target="_blank" rel="noreferrer">
            Open the {provider} sign-in page
          </a>
        </Text>
      ) : null}
      {opened ? (
        <Text size="md" role="secondary">
          Waiting for you to sign in.
        </Text>
      ) : null}
      {onUseCode === null ? null : (
        <Button size="md" color="secondary" dark={dark} onPress={onUseCode} disabled={busy} loading={busy} label="Use a code instead" />
      )}
    </Col>
  );
}
