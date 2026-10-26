import { type ReactNode, useState } from 'react';
import { Column } from '@stage-labs/kit/react-native/column';
import { Row } from '@stage-labs/kit/react-native/row';
import { Button } from '@stage-labs/kit/react-native/button';
import { Text } from '@stage-labs/kit/react-native/text';
import { signInPage } from '@metro-labs/client/api/attach-session';
import { copyText } from '../lib/clipboard.js';
import { TextLink } from './TextLink.js';

export function DeviceSignIn({ code, uri }: { code: string; uri: string | null }): ReactNode {
  const [copied, setCopied] = useState(false);
  const page = signInPage(uri);
  const copy = (): void => {
    copyText(code)
      .then(setCopied)
      .catch(() => undefined);
  };
  return (
    <Column gap={10}>
      <Row gap={12} align="center" wrap>
        <Text size="xl" fontWeight="semibold" selectable>
          {code}
        </Text>
        <Button size="md" color="secondary" onPress={copy} label={copied ? 'Copied' : 'Copy code'} />
      </Row>
      <TextLink size="md" url={page}>Open {page.replace(/^https:\/\//, '')}</TextLink>
      <Text size="md" color="secondary">
        Waiting for you to sign in.
      </Text>
    </Column>
  );
}
