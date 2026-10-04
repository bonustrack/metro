import { type ReactNode, useState } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Button } from '@stage-labs/kit/react-native/button';
import { Text } from '@stage-labs/kit/react-native/text';
import { signInPage } from '@metro-labs/client/api/attach-session';
import { copyText } from '../lib/clipboard.js';
import { TextLink } from './TextLink.js';

export function DeviceSignIn({ code, uri }: { code: string; uri: string | null }): ReactNode {
  const dark = useKitScheme() === 'dark';
  const [copied, setCopied] = useState(false);
  const page = signInPage(uri);
  const copy = (): void => {
    copyText(code)
      .then(setCopied)
      .catch(() => undefined);
  };
  return (
    <Col gap={10}>
      <Row gap={12} align="center" wrap>
        <Text size="xl" weight="semibold" selectable>
          {code}
        </Text>
        <Button size="md" color="secondary" dark={dark} onPress={copy} label={copied ? 'Copied' : 'Copy code'} />
      </Row>
      <TextLink size="2xs" url={page}>Open {page.replace(/^https:\/\//, '')}</TextLink>
      <Text size="2xs" role="secondary">
        Waiting for you to sign in.
      </Text>
    </Col>
  );
}
