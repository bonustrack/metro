import { type ReactNode } from 'react';
import { Column } from '@stage-labs/kit/react-native/column';
import { Row } from '@stage-labs/kit/react-native/row';
import { Button } from '@stage-labs/kit/react-native/button';
import { Text } from '@stage-labs/kit/react-native/text';
import { routeHash } from '@metro-labs/client/route';
import { TextLink } from './TextLink.js';

const NOTICE_WIDTH = 480;
const CENTER_SELF = { alignSelf: 'center' } as const;

export function Notice({ text, onRetry, retryLabel }: { text: string; onRetry: () => void; retryLabel: string }): ReactNode {
  return (
    <Row justify="center" align="center" weight={1} padding={24}>
      <Column gap={16} align="center" width="100%" maxWidth={NOTICE_WIDTH}>
        <Text size="xs" color="secondary">
          {text}
        </Text>
        <Button color="secondary" label={retryLabel} onPress={onRetry} style={CENTER_SELF} />
        <TextLink to={routeHash({ kind: 'servers' })}>All agents</TextLink>
      </Column>
    </Row>
  );
}
