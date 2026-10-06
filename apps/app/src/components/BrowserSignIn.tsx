import { type ReactNode, useState } from 'react';
import { checkAccountIdentity, type AccountIdentity } from '@metro-labs/client/auth/account';
import { Col } from '@stage-labs/kit/react-native/box';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Button } from '@stage-labs/kit/react-native/button';
import { Text } from '@stage-labs/kit/react-native/text';
import { stateOf } from '@metro-labs/client/api/attach-session';
import { rememberSignIn } from '@metro-labs/client/api/sign-in-return';
import { location } from '@metro-labs/client/platform';
import { Platform } from 'react-native';
import { TextLink } from './TextLink.js';
import { openExternal } from '../lib/open.js';

const ON_THE_WEB = 'This sign-in comes back to metro.box, so it works from a browser only for now. Connect this channel on metro.box.';

function OnTheWeb({ provider, onUseCode, busy }: { provider: string; onUseCode: (() => void) | null; busy: boolean }): ReactNode {
  const dark = useKitScheme() === 'dark';
  return (
    <Col gap={10}>
      <Text size="2xs" role="secondary">
        {ON_THE_WEB}
      </Text>
      <TextLink url={`https://metro.box/${location().hash()}`}>{`Sign in with ${provider} on metro.box`}</TextLink>
      {onUseCode === null ? null : (
        <Button size="md" color="secondary" dark={dark} onPress={onUseCode} disabled={busy} loading={busy} label="Use a code instead" />
      )}
    </Col>
  );
}

interface BrowserSignInProps {
  agentId: string;
  base: string;
  identity: AccountIdentity | null;
  attachId: string;
  authorizeUrl: string;
  provider: string;
  busy: boolean;
  onUseCode: (() => void) | null;
}

export function BrowserSignIn(props: BrowserSignInProps): ReactNode {
  const { agentId, base, identity, attachId, authorizeUrl, provider, busy, onUseCode } = props;
  const dark = useKitScheme() === 'dark';
  const [opened, setOpened] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const open = (): void => {
    try {
      checkAccountIdentity(identity);
      rememberSignIn({
        state: stateOf(authorizeUrl),
        agentsBase: base,
        agentId,
        attachId,
        backHash: location().hash(),
        startedAt: Date.now(),
        identity,
      });
      setBlocked(!openExternal(authorizeUrl));
      setOpened(true);
    } catch (err) {
      setBlocked(false);
      setError(err instanceof Error ? err.message : 'Start the sign-in again.');
    }
  };
  if (Platform.OS !== 'web') return <OnTheWeb provider={provider} onUseCode={onUseCode} busy={busy} />;
  return (
    <Col gap={10}>
      <Button color="primary" dark={dark} onPress={open} disabled={busy} label={`Sign in with ${provider}`} />
      {blocked ? (
        <TextLink size="2xs" url={authorizeUrl}>Open the {provider} sign-in page</TextLink>
      ) : null}
      {error === null ? null : <Text size="2xs" role="danger">{error}</Text>}
      {opened ? (
        <Text size="2xs" role="secondary">
          Waiting for you to sign in.
        </Text>
      ) : null}
      {onUseCode === null ? null : (
        <Button size="md" color="secondary" dark={dark} onPress={onUseCode} disabled={busy} loading={busy} label="Use a code instead" />
      )}
    </Col>
  );
}
