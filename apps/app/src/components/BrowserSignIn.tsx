import { type ReactNode, useState } from 'react';
import { type AccountIdentity } from '@metro-labs/client/auth/account';
import { Column } from '@stage-labs/kit/react-native/column';
import { Row } from '@stage-labs/kit/react-native/row';
import { Button } from '@stage-labs/kit/react-native/button';
import { Text } from '@stage-labs/kit/react-native/text';
import { location } from '@metro-labs/client/platform';
import { Platform } from 'react-native';
import { TextLink } from './TextLink.js';
import { openExternal } from '../lib/open.js';
import { prepareSignIn, type SignInOpened } from '../lib/use-attach.js';

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
  openedBefore: SignInOpened | null;
}

export function BrowserSignIn(props: BrowserSignInProps): ReactNode {
  const { agentId, base, identity, attachId, authorizeUrl, provider, busy, onUseCode, openedBefore } = props;
  const [opened, setOpened] = useState(openedBefore !== null);
  const [blocked, setBlocked] = useState(openedBefore === 'blocked');
  const [error, setError] = useState<string | null>(null);
  const open = (): void => {
    try {
      prepareSignIn({ agentId, base, identity, attachId, authorizeUrl });
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
      {opened && !blocked ? null : <Button color="primary" onPress={open} disabled={busy} label="Connect" />}
      {blocked ? (
        <TextLink size="md" url={authorizeUrl}>Open the {provider} sign-in page</TextLink>
      ) : null}
      {error === null ? null : <Text size="md" color="danger">{error}</Text>}
      {opened ? (
        <Row gap={8} align="center" wrap>
          <Text size="md" color="secondary">
            Waiting for you to sign in.
          </Text>
          {blocked ? null : <TextLink size="md" url={authorizeUrl}>Open it again</TextLink>}
        </Row>
      ) : null}
      {onUseCode === null ? null : (
        <Button size="md" color="secondary" onPress={onUseCode} disabled={busy} loading={busy} label="Use a code instead" />
      )}
    </Column>
  );
}
