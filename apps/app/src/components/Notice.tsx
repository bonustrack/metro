import { type ReactNode } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Button } from '@stage-labs/kit/react-native/button';
import { Text } from '@stage-labs/kit/react-native/text';
import { routeHash } from '@metro-labs/client/route';
import { TextLink } from './TextLink.js';

const NOTICE_WIDTH = 480;
const CENTER_SELF = { alignSelf: 'center' } as const;

export function Notice({ text, onRetry, retryLabel }: { text: string; onRetry: () => void; retryLabel: string }): ReactNode {
  const dark = useKitScheme() === 'dark';
  return (
    <Row justify="center" align="center" flex={1} padding={24}>
      <Col gap={16} align="center" width="100%" maxWidth={NOTICE_WIDTH}>
        <Text size="xs" role="secondary">
          {text}
        </Text>
        <Button color="secondary" dark={dark} label={retryLabel} onPress={onRetry} style={CENTER_SELF} />
        <TextLink to={routeHash({ kind: 'servers' })}>All agents</TextLink>
      </Col>
    </Row>
  );
}
