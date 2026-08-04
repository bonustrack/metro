import { type ReactNode } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { Card } from '@stage-labs/kit/react-native/card';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Text, Button } from './ui';
import { CARD_PADDING } from '../theme';
import { type CreatedAgent } from '../api/client';
import { CopyBlock } from './CopyBlock';

export function NewAgentKey({
  created,
  onDismiss,
}: {
  created: CreatedAgent;
  onDismiss: () => void;
}): ReactNode {
  const dark = useKitScheme() === 'dark';
  return (
    <Card dark={dark} padding={CARD_PADDING}>
      <Col gap={16}>
        <Col gap={4}>
          <Text size="lg" weight="semibold">
            Agent “{created.name}” created
          </Text>
          <Text size="sm" role="secondary">
            Paste the command below into your terminal. This API key stays available on the
            agent, hidden behind Reveal.
          </Text>
        </Col>
        <CopyBlock label="api key" value={created.key} />
        <CopyBlock label="add to claude code" value={created.command} />
        <Row justify="end">
          <Button color="secondary" dark={dark} onPress={onDismiss} label="Done" />
        </Row>
      </Col>
    </Card>
  );
}
