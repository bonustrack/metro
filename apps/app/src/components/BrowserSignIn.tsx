import { type ReactNode, useState } from 'react';
import { checkAccountIdentity, shareActiveAccount, type AccountIdentity } from '@metro-labs/client/auth/account';
import { Column } from '@stage-labs/kit/react-native/column';
import { Button } from '@stage-labs/kit/react-native/button';
import { Text } from '@stage-labs/kit/react-native/text';
import { stateOf } from '@metro-labs/client/api/attach-session';
import { rememberSignIn } from '@metro-labs/client/api/sign-in-return';
import { location } from '@metro-labs/client/platform';
import { Platform } from 'react-native';
import { TextLink } from './TextLink.js';
import { openExternal } from '../lib/open.js';
import { logError } from '../lib/log.js';

const ON_THE_WEB = 'This sign-in works only in a browser for now. Connect this channel on metro.box.';

function OnTheWeb({ provider, onUseCode, busy }: { provider: string; onUseCode: (() => void) | null; busy: boolean }): ReactNode {
  return (
    <Column gap={10}>
      <Text size="md" color="secondary">
        {ON_THE_WEB}
      </Text>
      <TextLink url={`https://metro.box/${location().hash()}`}>{`Sign in with ${provider} on metro.box`}</TextLink>
      {onUseCode === null ? null : (
        <Button size="md" color="secondary" onPress={onUseCode} disabled={busy} loading={busy} label="Use a code instead" />
      )}
    </Column>
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
      shareActiveAccount().catch(logError('share the account with the sign-in tab'));
      setBlocked(!openExternal(authorizeUrl));
      setOpened(true);
    } catch (err) {
      setBlocked(false);
      setError(err instanceof Error ? err.message : 'Start the sign-in again.');
    }
  };
  if (Platform.OS !== 'web') return <OnTheWeb provider={provider} onUseCode={onUseCode} busy={busy} />;
  return (
    <Column gap={10}>
      <Button color="primary" onPress={open} disabled={busy} label={`Sign in with ${provider}`} />
      {blocked ? (
        <TextLink size="md" url={authorizeUrl}>Open the {provider} sign-in page</TextLink>
      ) : null}
      {error === null ? null : <Text size="md" color="danger">{error}</Text>}
      {opened ? (
        <Text size="md" color="secondary">
          Waiting for you to sign in.
        </Text>
      ) : null}
      {onUseCode === null ? null : (
        <Button size="md" color="secondary" onPress={onUseCode} disabled={busy} loading={busy} label="Use a code instead" />
      )}
    </Column>
  );
}
