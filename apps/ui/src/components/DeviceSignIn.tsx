import { type ReactNode, useState } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Text, Button } from './ui.js';
import { signInPage } from '../api/attach-session.js';

export function DeviceSignIn({ code, uri }: { code: string; uri: string | null }): ReactNode {
  const dark = useKitScheme() === 'dark';
  const [copied, setCopied] = useState(false);
  const page = signInPage(uri);
  const copy = (): void => {
    navigator.clipboard.writeText(code).then(
      () => {
        setCopied(true);
      },
      () => {
        setCopied(false);
      },
    );
  };
  return (
    <Col gap={10}>
      <Row gap={12} align="center" wrap>
        <Text size="3xl" weight="semibold" selectable>
          {code}
        </Text>
        <Button size="sm" color="secondary" dark={dark} onPress={copy} label={copied ? 'Copied' : 'Copy code'} />
      </Row>
      <Text size="sm">
        <a className="hint-link" href={page} target="_blank" rel="noreferrer">
          Open {page.replace(/^https:\/\//, '')}
        </a>
      </Text>
      <Text size="sm" role="secondary">
        Waiting for you to sign in.
      </Text>
    </Col>
  );
}
